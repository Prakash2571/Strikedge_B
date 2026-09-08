/**
 * StrikeEdge backend entrypoint.
 *
 * This file replaces CalSpread's 5,584-line `src/index.ts`. Everything that was not
 * the Box strategy — calendar spreads, futures analytics, option-OI capture, the
 * hourly/EOD schedulers, Yahoo dividends, the F&O board pages, the browser-wide
 * market-data SSE, the Zerodha OAuth login and the admin-token layer — is gone.
 * What remains is: configuration, PostgreSQL, the access gate, the Box module, the
 * dual-broker runtime, the token acquisition service and the Mongo projector,
 * assembled in a documented order.
 *
 * TWO ORDERINGS ARE LOAD-BEARING AND ARE THE REASON THIS FILE READS TOP-TO-BOTTOM.
 *
 * BOOT
 *   1. parse and validate configuration
 *   2. start PostgreSQL and run/check migrations
 *   3. load access-session infrastructure
 *   4. load Box settings/session state
 *   5. reconstruct open positions, intents, attempts and residual exposure
 *   6. start the Mongo outbox projector INDEPENDENTLY (never a boot dependency)
 *   7. start the daily token broker
 *   8. once a valid token exists, load instruments
 *   9. start the dedicated Box market-data feed
 *  10. reconcile unresolved live broker state
 *  11. start the always-on position monitor
 *  12. keep new scanner discovery STOPPED until explicitly started
 *  13. never auto-arm live entry
 *
 * SHUTDOWN
 *   1. block new Box entry            5. stop market-data subscriptions/socket
 *   2. stop scanner discovery         6. stop monitoring/timers WITHOUT flattening
 *   3. stop mutating HTTP             7. flush bounded Mongo outbox work
 *   4. stop token polling             8. close HTTP/SSE  9. close Mongo  10. close PG
 *
 * SIGTERM IS NOT AN INSTRUCTION TO LIQUIDATE. Open positions stay open and the
 * durable recovery path adopts them on restart. See `src/shutdown.ts`.
 */

import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";

import { loadAppConfig, boolOr, ConfigError } from "./config.js";
import { closePg, initPg, isPgReady, pgConfigFromEnv, pgStatus, query } from "./pg/pool.js";
import { assertMigrated, listMigrationFiles, runMigrations } from "./pg/migrate.js";

import { KiteClient } from "./kite.js";
import { TickerHub } from "./hub.js";
import { ActiveBrokerManager } from "./brokers/registry.js";
import type { BrokerId } from "./brokers/types.js";
import { LocalChargeCalculator } from "./box/localCharges.js";
import { registerBoxModule, type BoxModule } from "./box/index.js";
import { countUnresolvedBoxOrderIntentsForBroker } from "./box/repository.js";
import {
  deriveFnoBoard,
  istDayKey,
  isMarketOpen,
  makeIdResolver,
  makePriceChargeGroups,
} from "./boxSupport.js";

import { createRequireOperator, corsMiddleware, errorHandler, getOperatorRole, startSessionSweeper } from "./access/middleware.js";
import { registerAccessRoutes } from "./access/routes.js";
import { createVerifyRateLimit } from "./access/rateLimit.js";
import type { AccessSessionConfig } from "./access/sessionStore.js";

import { registerRuntimeStatusRoutes, type RuntimeStatusSnapshot } from "./runtime/statusRoutes.js";
import { registerBrokerRoutes, type SwitchResult } from "./brokerRoutes.js";

import { BrokerTokenAcquisitionService } from "./tokens/brokerTokenService.js";
import { systemClock } from "./tokens/istClock.js";
import type { BrokerProviderConfigs } from "./tokens/brokerTokenService.js";
import {
  clearDhanSession,
  loadDhanSession,
  loadKiteSession,
  saveDhanSession,
  saveKiteSession,
  __internal as brokerSessionInternals,
} from "./brokerState/brokerSessions.js";

import { MongoExportClient, exportConfigFromEnv } from "./outbox/mongo.js";
import { Projector } from "./outbox/projector.js";
import { getExportStatus } from "./outbox/status.js";
import { getPool } from "./pg/pool.js";

import { ShutdownCoordinator, shutdownExitCode } from "./shutdown.js";
import { clearTrackedIntervals } from "./trackedTimers.js";

/* ========================================================================== */
/*  1. CONFIGURATION                                                          */
/* ========================================================================== */

let config: ReturnType<typeof loadAppConfig>;
try {
  config = loadAppConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error("[FATAL] StrikeEdge refuses to start with invalid configuration.");
    for (const p of err.problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  throw err;
}

const accessSession: AccessSessionConfig = {
  siteAccessSecret: process.env.SITE_ACCESS_SECRET,
  ttlHours: config.siteSessionTtlHours,
};

if (!accessSession.siteAccessSecret) {
  // Not fatal, deliberately: the gate FAILS CLOSED (every protected route 401s and
  // verify can never succeed), so an operator who forgot the secret gets a process
  // that is safe and diagnosable rather than one that will not boot at all.
  console.error(
    "[Access] SITE_ACCESS_SECRET is not set. The gate is FAIL CLOSED: every /api/box/*, " +
      "/api/broker/*, /api/runtime/status and /api/export/status request will return 401 " +
      "and no passcode will be accepted. An unset secret NEVER means 'no passcode required'.",
  );
}

/**
 * The two independent live-trading DEPLOYMENT gates, read once and reported once.
 *
 * Nothing in this file may arm live trading. Even with both gates true and the active
 * broker's own gate true, the process still starts runtime-DISARMED: the runtime live
 * controls default false on every process start and must be armed through the
 * protected API. Entering the site passcode arms nothing.
 */
const boxExecutionMode = (process.env.BOX_EXECUTION_MODE ?? "paper_latency").trim();
const boxLiveTradingEnabled = boolOr(process.env.BOX_LIVE_TRADING_ENABLED, false);
const zerodhaLiveTradingEnabled = boolOr(process.env.ZERODHA_LIVE_TRADING_ENABLED, false);
const dhanLiveTradingEnabled = boolOr(process.env.DHAN_LIVE_TRADING_ENABLED, false);

if (boxExecutionMode === "live" && !boxLiveTradingEnabled) {
  console.error(
    "[FATAL] BOX_EXECUTION_MODE=live requires BOX_LIVE_TRADING_ENABLED=true. " +
      "Live execution is double-gated at the deployment level and StrikeEdge fails closed " +
      "rather than degrading silently to paper.",
  );
  process.exit(1);
}

/* ========================================================================== */
/*  BROKER RUNTIME (constructed now, started only after a validated token)     */
/* ========================================================================== */

const kite = new KiteClient({ apiKey: process.env.KITE_API_KEY_EXPECTED ?? "" });

/**
 * Set once the Box module exists. Lets a feed death notify the engine without this
 * line having to know about the module — the engine then drops its cached books
 * instead of trading a frozen order book.
 */
let onFeedSessionLost: (() => void) | null = null;

const tickerHub = new TickerHub(
  () => ({ apiKey: kite.getApiKey(), accessToken: kite.getAccessToken() }),
  () => {
    // Zerodha rejected the token. Clear memory AND the encrypted stored copy so a
    // restart does not restore a dead token, then let the engine invalidate books.
    kite.clearSession();
    void brokerSessionInternals
      .invalidateSession("zerodha", "feed_auth_failure")
      .catch(() => undefined);
    onFeedSessionLost?.();
  },
);

const brokerManager = new ActiveBrokerManager({
  kite,
  tickerHub,
  boxConfig: () => boxModule.engine.getConfigRaw(),
  istDayKey,
  // Read fresh on every connect: a lane reconnecting after a token refresh must use
  // the CURRENT access token, not the one captured when the feed was constructed.
  zerodhaCredentials: () => ({ apiKey: kite.getApiKey(), accessToken: kite.getAccessToken() }),
  // BOX-LANE ticks go straight to the Box quote store, NOT through the hub: the hub
  // owns broadcast caches, and thousands of option strikes do not belong on a
  // browser fan-out path. StrikeEdge has no browser market-data SSE at all, but the
  // separation is kept because it is what bounds the Box lane's own token budget.
  onBoxLaneTicks: (ticks) => {
    brokerManager.noteTick();
    boxModule.engine.ingestBoxLaneTicks(ticks);
  },
  onBoxLaneConnection: (connected) => boxModule.engine.onBoxLaneConnection(connected),
  onDhanTicks: (ticks) => {
    brokerManager.noteTick();
    tickerHub.ingestExternalTicks(ticks);
  },
  onDhanConnection: (connected) => tickerHub.setExternalConnected(connected),
  onSessionLost: (broker, reason) => {
    console.warn(`[Broker] ${broker} session lost: ${reason}`);
    onFeedSessionLost?.();
  },
});

/* ========================================================================== */
/*  HTTP APP                                                                  */
/* ========================================================================== */

const app = express();
app.disable("x-powered-by");
// Behind nginx. Needed so the verify rate limiter and the session breadcrumb see the
// real client address rather than the proxy's.
app.set("trust proxy", true);
app.use(express.json({ limit: "256kb" }));

// EXACT-ORIGIN CORS WITH CREDENTIALS. Never a wildcard — a wildcard with credentials
// is rejected by browsers anyway, and answering `*` while asking for cookies is the
// classic way to end up with an origin check that does nothing.
app.use(corsMiddleware(config));

const requireOperator = createRequireOperator({ config });

/**
 * Refuse MUTATING requests once shutdown has begun (step 3 of the shutdown order).
 *
 * Reads remain answerable while the process drains, but a POST arriving during
 * teardown must not be able to start a new Box, arm a session or place an order.
 */
let shuttingDown = false;
app.use((req: Request, res: Response, next) => {
  const mutating = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
  if (shuttingDown && mutating) {
    res.status(503).json({ error: "StrikeEdge is shutting down; mutating requests are refused." });
    return;
  }
  next();
});

/**
 * The ONLY unauthenticated informational endpoint. Deliberately contentless beyond
 * liveness: a health check that reported broker or token state would be a public
 * readout of the trading system.
 */
app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true, service: "strikedge", shutting_down: shuttingDown });
});

registerAccessRoutes(app, {
  config,
  session: accessSession,
  verifyRateLimit: createVerifyRateLimit(),
});

/* ========================================================================== */
/*  BOX MODULE                                                                */
/* ========================================================================== */

const boxModule: BoxModule = registerBoxModule(app, {
  kite,
  tickerHub,
  getAllInstruments: () => brokerManager.instruments(),
  getBoard: async () => deriveFnoBoard(await brokerManager.instruments()),
  priceChargeGroups: makePriceChargeGroups(kite),
  istDayKey,
  makeIdResolver,
  isMarketOpen: () => isMarketOpen(),
  getBasketMargin: (orders) => kite.getBasketMargin(orders),
  requireOperator,
  getOperatorRole,
  // ---- broker-neutral wiring: every one of these routes to the ACTIVE broker ----
  activeBroker: () => brokerManager.activeBroker,
  // Stamped onto every durable instrument reservation and re-checked before
  // execution, so a lease taken under a superseded broker cannot authorise a trade.
  brokerGeneration: () => brokerManager.generation,
  marketData: brokerManager.marketData(),
  margins: brokerManager.margins(),
  feed: {
    addTickListener: (fn) =>
      tickerHub.addTickListener((ticks) => {
        brokerManager.noteTick();
        fn(ticks);
      }),
    addConnectionListener: (fn) => tickerHub.addConnectionListener(fn),
    retain: () => tickerHub.retain(),
    subscribeTokens: (tokens) => brokerManager.subscribeTokens(tokens),
    unsubscribeTokens: (tokens) => brokerManager.unsubscribeTokens(tokens),
    setStrategyTokens: (tokens) => brokerManager.setStrategyTokens(tokens),
    // The DEDICATED Box lane — ONE socket on the ACTIVE broker, with its own refcount
    // table and token budget. Never two brokers at once.
    setBoxTokens: (tokens) => brokerManager.setBoxTokens(tokens),
    subscribedCount: () => brokerManager.subscribedCount(),
    isConnected: () => brokerManager.feedConnected(),
  },
  // The ACTIVE broker's fee schedule. A Dhan trade costed with Zerodha brokerage
  // would make the expected-net entry gate spend money it does not have.
  charges:
    brokerManager.activeBroker === "dhan"
      ? brokerManager.dhanChargeCalculator()
      : new LocalChargeCalculator(),
  // The engine never builds broker transports itself. The registry assembles the
  // ACTIVE broker's adapter and REFUSES to build one for any other broker.
  createLiveAdapter: (ctx) => brokerManager.createLiveAdapter(ctx),
});

onFeedSessionLost = () => boxModule.engine.onSessionLost();

/**
 * Give the broker manager its view of live exposure and the teardown hooks a switch
 * needs. Done here rather than in the constructor because the engine must exist
 * first — the manager inspects it, and the engine consumes the manager's providers.
 */
brokerManager.attach(
  {
    scannerRunning: () => boxModule.engine.exposureSummary().scannerRunning,
    openPositionCount: () => boxModule.engine.exposureSummary().openPositions,
    brokersWithOpenPositions: () => boxModule.engine.exposureSummary().brokersWithOpenPositions,
    workingOrderCount: () => boxModule.engine.exposureSummary().workingOrders,
    executionInFlight: () => boxModule.engine.exposureSummary().executionInFlight,
    reconciliationComplete: () => boxModule.engine.exposureSummary().reconciliationComplete,
    residualLegCount: () => boxModule.engine.exposureSummary().residualLegs,
    unknownOrderCount: () => boxModule.engine.exposureSummary().unknownOrders,
    unresolvedIntentsFor: (broker) => countUnresolvedBoxOrderIntentsForBroker(broker),
  },
  {
    stopScanner: () => boxModule.engine.stop(),
    invalidateBooks: () => boxModule.engine.invalidateBooks(),
    clearInstrumentReservations: () => boxModule.engine.clearInstrumentReservations(),
    reloadUniverse: () => boxModule.engine.reloadUniverse(),
    publish: () => boxModule.engine.publishNow(),
  },
);

/* ========================================================================== */
/*  MONGO PROJECTOR (independent of everything else)                          */
/* ========================================================================== */

const mongoExportConfig = exportConfigFromEnv();
const mongoExport = new MongoExportClient(mongoExportConfig);

/**
 * Constructed in `boot()`, not here, because it needs the live `pg.Pool` and the pool
 * does not exist until step 2. Held in a nullable so the shutdown steps can reference
 * it unconditionally — a shutdown that arrives before boot finished must still be able
 * to run every later step rather than throwing on a missing projector.
 */
let projector: Projector | null = null;

/* ========================================================================== */
/*  DAILY DUAL-BROKER TOKEN ACQUISITION                                       */
/* ========================================================================== */

/**
 * Which broker the token service is allowed to bring up.
 *
 * This is the enforcement point for the single-active-broker invariant on the token
 * path: a successful acquisition for the STANDBY broker stores an encrypted token and
 * nothing else — no instruments, no socket, no subscriptions, no scanner.
 */
/**
 * The two token-provider configurations.
 *
 * Built explicitly, side by side, precisely because they must NOT be derived from one
 * another: the operator may legitimately set the same value for both passcodes (the
 * CalSpread deployment protects both routes with one `TOKEN_ROUTE_SECRET`), but the
 * application must never assume they are identical nor copy one into the other. A
 * future rotation of one secret then works without silently breaking the other.
 *
 * `requireHttps` is true outside tests, so a plaintext token URL is refused.
 */
const tokenProviderConfigs: BrokerProviderConfigs = {
  zerodha: {
    url: (process.env.KITE_TOKEN_BROKER_URL ?? "https://calspread.online/api/kite/token").trim(),
    passcode: process.env.KITE_TOKEN_BROKER_PASSCODE ?? "",
    ...(process.env.KITE_API_KEY_EXPECTED?.trim()
      ? { expectedIdentity: process.env.KITE_API_KEY_EXPECTED.trim() }
      : {}),
    requestTimeoutMs: Number(process.env.BROKER_TOKEN_REQUEST_TIMEOUT_MS ?? 10_000),
    requireHttps: config.nodeEnv !== "test",
  },
  dhan: {
    url: (process.env.DHAN_TOKEN_URL ?? "https://calspread.online/api/dhan/token").trim(),
    passcode: process.env.DHAN_TOKEN_BROKER_PASSCODE ?? "",
    ...(process.env.DHAN_CLIENT_ID_EXPECTED?.trim()
      ? { expectedIdentity: process.env.DHAN_CLIENT_ID_EXPECTED.trim() }
      : {}),
    requestTimeoutMs: Number(process.env.BROKER_TOKEN_REQUEST_TIMEOUT_MS ?? 10_000),
    requireHttps: config.nodeEnv !== "test",
  },
};

const tokenService = new BrokerTokenAcquisitionService({
  clock: systemClock,
  configs: tokenProviderConfigs,
  pollStart: (process.env.BROKER_TOKEN_POLL_START ?? "09:00").trim(),
  pollIntervalMs: Number(process.env.BROKER_TOKEN_POLL_INTERVAL_MS ?? 60_000),
  persist: {
    saveZerodha: async ({ apiKey, accessToken, loginDate }) => {
      await saveKiteSession({
        access_token: accessToken,
        user_id: "",
        user_name: "",
        login_date: loginDate,
        api_key: apiKey,
        source_url: process.env.KITE_TOKEN_BROKER_URL ?? "",
      });
    },
    saveDhan: async ({ clientId, accessToken, loginDate, expiresAtMs }) => {
      await saveDhanSession({
        access_token: accessToken,
        dhan_client_id: clientId,
        dhan_client_name: "",
        dhan_client_ucc: "",
        given_power_of_attorney: false,
        expiry_time: expiresAtMs,
        login_date: loginDate,
        source_url: process.env.DHAN_TOKEN_URL ?? "",
      });
    },
    hasValidToken: async (broker, istDay) => {
      if (broker === "zerodha") {
        const s = await loadKiteSession().catch(() => null);
        // Zerodha tokens are day-scoped: yesterday's token is dead by definition.
        return s !== null && s.login_date === istDay;
      }
      const s = await loadDhanSession().catch(() => null);
      if (!s) return false;
      // Dhan honours an EXPLICIT expiry. A null expiry is UNKNOWN, not "valid
      // forever": it is accepted here and retired operationally by a 401.
      if (s.expiry_time !== null) return s.expiry_time > Date.now();
      return true;
    },
    invalidate: async (broker, reason) => {
      if (broker === "dhan") await clearDhanSession(reason);
      else await brokerSessionInternals.invalidateSession("zerodha", reason);
    },
  },
  feedProbe: {
    // Scoped to the ACTIVE broker on purpose: the standby broker may hold a valid
    // stored token, and reporting a feed for it would contradict the single-active-
    // broker invariant the status endpoint exists to make visible.
    feedConnected: (broker) => brokerManager.activeBroker === broker && brokerManager.feedConnected(),
    wantedTokenCount: (broker) =>
      brokerManager.activeBroker === broker ? brokerManager.laneStats("box").wantedTokens : 0,
    subscribedTokenCount: (broker) =>
      brokerManager.activeBroker === broker ? brokerManager.laneStats("box").subscribedTokens : 0,
    lastAuthoritativeDepthAgeMs: (broker) =>
      brokerManager.activeBroker === broker ? brokerManager.laneStats("box").lastTickAgeMs : null,
    reconnectCount: (broker) =>
      brokerManager.activeBroker === broker ? brokerManager.laneStats("box").reconnects : 0,
  },
  callbacks: {
    installZerodhaToken: (apiKey, accessToken) => {
      kite.installProvidedToken(apiKey, accessToken);
    },
    installDhanToken: () => {
      // Dhan's client reads its session from the encrypted store on demand, so the
      // durable write in `persist.saveDhan` IS the installation. Nothing to do here,
      // and deliberately nothing that could open a socket for a standby broker.
    },
    isActiveBroker: (broker) => brokerManager.activeBroker === broker,
    onActiveBrokerReady: async (broker) => {
      console.log(`[Token] ${broker} token installed — bringing the active broker runtime up.`);
      // Instruments FIRST, then the socket: a status read during startup should say
      // "connecting" rather than "live with an empty board". `startActiveRuntime`
      // performs exactly that sequence and then resubscribes the Box token set.
      await brokerManager.startActiveRuntime();
      // Any book cached before the token existed is not authoritative depth.
      boxModule.engine.invalidateBooks();
      boxModule.engine.publishNow();
    },
    onBrokerAuthFailure: async (broker, reason) => {
      console.warn(`[Token] ${broker} authentication failure (${reason}) — blocking new entry.`);
      if (brokerManager.activeBroker === broker) {
        // Close the socket and drop executable books. Open-position and recovery
        // state is PRESERVED: nothing here liquidates or forgets exposure.
        brokerManager.stopFeeds();
        boxModule.engine.invalidateBooks();
        boxModule.engine.stop();
        boxModule.engine.publishNow();
      }
    },
  },
});

/* ========================================================================== */
/*  PROTECTED STATUS AND BROKER ROUTES                                        */
/* ========================================================================== */

let migrationState = { applied: 0, pending: 0 };

/**
 * Reduce a broker account identity to something safe to display.
 *
 * A Zerodha user id or a Dhan client id is not a credential on its own, but paired
 * with a leaked token it is exactly what an attacker needs to know they have a usable
 * pair — and the dashboard only ever needs to answer "is this the account I expect?".
 * Keep the last four characters, mask the rest.
 */
function redactIdentity(raw: string | null): string | null {
  if (!raw) return null;
  return raw.length <= 4 ? "•".repeat(raw.length) : `${"•".repeat(Math.min(raw.length - 4, 8))}${raw.slice(-4)}`;
}

registerRuntimeStatusRoutes(app, {
  requireOperator,
  runtime: {
    getRuntimeStatus: async (): Promise<RuntimeStatusSnapshot> => {
      const exposure = boxModule.engine.exposureSummary();
      const tokenStatus = tokenService.status();
      const tokens = [tokenStatus.zerodha, tokenStatus.dhan];
      const reasons: string[] = [];
      if (boxExecutionMode !== "live") reasons.push(`execution_mode_${boxExecutionMode}`);
      if (!boxLiveTradingEnabled) reasons.push("box_live_trading_disabled");
      if (brokerManager.activeBroker === "zerodha" && !zerodhaLiveTradingEnabled) {
        reasons.push("zerodha_live_trading_disabled");
      }
      if (brokerManager.activeBroker === "dhan" && !dhanLiveTradingEnabled) {
        reasons.push("dhan_live_trading_disabled");
      }
      if (!isPgReady()) reasons.push("postgres_unavailable");
      if (!exposure.reconciliationComplete) reasons.push("reconciliation_incomplete");
      const activeToken = tokens.find((t) => t.broker === brokerManager.activeBroker);
      if (!activeToken || activeToken.state !== "ready") reasons.push("active_broker_token_not_ready");
      return {
        brokers: tokens.map((t) => ({
          broker: t.broker,
          token_state: t.state,
          ist_day: t.istDay,
          last_attempt_at: t.lastAttemptAt === null ? null : new Date(t.lastAttemptAt).toISOString(),
          last_success_at: t.lastSuccessAt === null ? null : new Date(t.lastSuccessAt).toISOString(),
          last_error: t.lastError,
          feed_connected: t.feedConnected,
          wanted_token_count: t.wantedTokenCount,
          subscribed_token_count: t.subscribedTokenCount,
          last_depth_age_ms: t.lastAuthoritativeDepthAgeMs,
          reconnect_count: t.reconnectCount,
        })),
        active_broker: brokerManager.activeBroker,
        pg_ready: isPgReady(),
        migration_state: migrationState,
        recovery_ready: exposure.reconciliationComplete,
        live_entry: { blocked: reasons.length > 0, reasons },
        recovery_pending: exposure.unknownOrders > 0,
        residual_exposure: exposure.residualLegs > 0,
      };
    },
  },
  exportStatus: {
    /**
     * Re-projected from the outbox snapshot rather than passed through, because the
     * two modules deliberately do not share a type: `src/outbox/status.ts` names its
     * fields in the projector's terms, and the HTTP contract names them in the
     * operator's. Mapping here keeps a rename on either side from silently changing
     * the public shape.
     */
    getExportStatus: async () => {
      const s = await getExportStatus(getPool(), mongoExportConfig.enabled);
      return {
        enabled: s.enabled,
        connected: s.connected,
        backlog_count: s.backlog,
        oldest_pending_age_ms: s.oldestPendingAgeMs,
        last_success_at: s.lastSuccessAt,
        last_error: s.lastError,
        dead_letter_count: s.deadLettered,
      };
    },
  },
});

registerBrokerRoutes(app, {
  requireOperator,
  manager: {
    activeBroker: () => brokerManager.activeBroker,
    generation: () => brokerManager.generation,
    sessionFor: (broker) => {
      const s = brokerManager.sessionFor(broker);
      // Deliberately RE-PROJECTED rather than spread: `BrokerSessionState` is an
      // internal shape and a future field on it must not silently become public.
      // Nothing here can carry a token — the state object has never held one.
      return {
        broker,
        connected: s.authenticated && !s.token_expired,
        state: !s.authenticated
          ? "waiting"
          : s.token_expired
            ? "expired"
            : brokerManager.activeBroker === broker
              ? "ready"
              : "standby",
        account_label: redactIdentity(s.client_id),
        established_at: s.login_at === null ? null : new Date(s.login_at).toISOString(),
        expires_at: s.token_expires_at === null ? null : new Date(s.token_expires_at).toISOString(),
      };
    },
    healthFor: (broker) => {
      const h = brokerManager.healthFor(broker);
      return {
        broker,
        authenticated: h.authenticated,
        data_ready: h.data_ready,
        trading_ready: h.trading_ready,
        problems: h.problems,
      };
    },
    switchBlockers: async (broker) => (await brokerManager.switchBlockers(broker)).map((b) => b.reason),
    selectBroker: async (broker, selectedBy): Promise<SwitchResult> => {
      const out = await brokerManager.switchBroker(broker, selectedBy);
      return out.ok
        ? { ok: true, broker, blockers: [] }
        : { ok: false, broker, blockers: out.blockers.map((b) => b.reason) };
    },
  },
  // Every open tab must see a broker change immediately, not on the next poll.
  onBrokerChanged: () => boxModule.engine.publishNow(),
});

app.use(errorHandler());

/* ========================================================================== */
/*  BOOT                                                                      */
/* ========================================================================== */

const httpServer = app.listen(config.port, () => {
  console.log(`StrikeEdge backend listening on http://localhost:${config.port}`);
  console.log(
    `[Gates] BOX_EXECUTION_MODE=${boxExecutionMode} BOX_LIVE_TRADING_ENABLED=${boxLiveTradingEnabled} ` +
      `ZERODHA_LIVE_TRADING_ENABLED=${zerodhaLiveTradingEnabled} DHAN_LIVE_TRADING_ENABLED=${dhanLiveTradingEnabled} ` +
      `— runtime live controls always start DISARMED.`,
  );
  void boot().catch((err) => {
    // Boot failures are LOUD and FATAL. A process that listens on the port and
    // answers /api/health while having adopted no positions is worse than one that
    // exited, because a supervisor will restart the latter into the recovery path.
    console.error("[FATAL] StrikeEdge boot failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
});

async function boot(): Promise<void> {
  /* 2. PostgreSQL, then migrations. Nothing else may run before this. */
  await initPg(pgConfigFromEnv());
  if (config.migrateOnBoot) {
    const result = await runMigrations();
    migrationState = { applied: result.applied.length + result.skipped.length, pending: 0 };
    console.log(
      `[PG] migrations: ${result.applied.length} applied, ${result.skipped.length} already present.`,
    );
  } else {
    await assertMigrated();
    migrationState = { applied: (await listMigrationFiles()).length, pending: 0 };
    console.log("[PG] schema verified (PG_MIGRATE_ON_BOOT=false; no migration applied).");
  }

  /* 3. Access-session infrastructure. */
  const sweeper = startSessionSweeper();
  sessionSweeperStop = sweeper.stop;

  /* Restore the durable active-broker selection BEFORE anything can price a trade.
     Without this a restart would silently revert to Zerodha and stamp new trades
     broker:"zerodha" while the operator believed Dhan was active. */
  await brokerManager.restore().catch((err) =>
    console.warn("[Broker] failed to restore the active broker:", err instanceof Error ? err.message : err),
  );

  /* 4 + 5 + 10 + 11. Box settings, session state, open positions, unresolved intents,
     execution attempts and residual exposure are all reconstructed by engine.boot(),
     which also reconciles unresolved live broker state and starts the ALWAYS-ON
     position monitor. Discovery of NEW boxes stays off (step 12). */
  await boxModule.boot();

  /* 6. The projector is started INDEPENDENTLY and is never a boot dependency: a
     MongoDB Atlas outage must not delay position adoption or reconciliation. */
  if (mongoExportConfig.enabled) {
    projector = new Projector(getPool(), mongoExport, {
      batchSize: mongoExportConfig.batchSize,
      intervalMs: mongoExportConfig.intervalMs,
      maxBackoffMs: mongoExportConfig.maxBackoffMs,
      maxAttempts: mongoExportConfig.maxAttempts,
    });
    projector.start();
    console.log(
      `[Mongo] outbox projector started (batch ${mongoExportConfig.batchSize}, every ${mongoExportConfig.intervalMs}ms).`,
    );
  } else {
    console.log("[Mongo] export disabled (MONGO_EXPORT_ENABLED=false or MONGODB_URI unset) — PostgreSQL remains authoritative.");
  }

  /* 7 + 8 + 9. The daily token broker. It is the ONLY thing that installs a token,
     loads instruments and opens the single dedicated Box market-data socket, and it
     does so only for the ACTIVE broker. */
  await tokenService.start();
  console.log("[Token] dual-broker acquisition scheduled (Asia/Kolkata).");

  /* 12 + 13. Deliberately absent: no engine.start(), no live arming. */
  console.log(
    "[Boot] complete. Scanner discovery is STOPPED and live entry is DISARMED — both require an explicit operator action.",
  );
}

let sessionSweeperStop: (() => void) | null = null;

/* ========================================================================== */
/*  SHUTDOWN                                                                  */
/* ========================================================================== */

const shutdownCoordinator = new ShutdownCoordinator({
  timeoutMs: config.shutdownTimeoutMs,
  steps: [
    {
      // 1 + 2. Block new entry and stop discovery FIRST, before HTTP stops accepting:
      // an in-flight request must not be able to start a new Box on the way out.
      name: "block new Box entry and stop scanner discovery",
      run: () => boxModule.engine.stop(),
    },
    {
      // 3. Reads still answer while the process drains; mutations are refused.
      name: "stop accepting mutating HTTP requests",
      run: () => {
        shuttingDown = true;
      },
    },
    {
      // 4.
      name: "stop broker token polling",
      run: () => tokenService.stop(),
    },
    {
      // 5.
      name: "stop market-data subscriptions and sockets",
      run: () => brokerManager.stopFeeds(),
    },
    {
      // 6. Disables entry again (belt and braces), stops the scanner, position
      // monitor, metrics sampler and P&L archiver, and clears every engine timer.
      // Queued order actions that never reached the broker are rejected and their
      // reservations released. NO POSITION IS FLATTENED AND NO FILL IS INVENTED.
      name: "stop monitoring and timers (positions preserved)",
      run: () => {
        boxModule.engine.dispose();
        sessionSweeperStop?.();
        const cleared = clearTrackedIntervals();
        if (cleared.length > 0) console.log(`[shutdown] cleared timers: ${cleared.join(", ")}`);
      },
    },
    {
      // 7. BOUNDED flush. One final drain pass, not "until empty": an unbounded
      // flush against a slow Atlas cluster would hold the deadline open, and the
      // backlog is durable in PostgreSQL either way.
      name: "flush bounded Mongo outbox work",
      run: async () => {
        const p = projector;
        if (!mongoExportConfig.enabled || !p) return;
        p.stop();
        const result = await p.runOnce();
        console.log(
          `[shutdown] outbox flush: claimed ${result.claimed}, published ${result.published}, ` +
            `failed ${result.failed} (remaining work is durable in PostgreSQL).`,
        );
      },
    },
    {
      /**
       * 8. Stop listening, release idle keep-alives, give real in-flight requests a
       * short grace, then destroy the stragglers.
       *
       * `server.close()` does not resolve until every connection ends, and SSE
       * connections never end on their own. Awaiting it naively would make EVERY
       * shutdown hang to the deadline — the false alarm that teaches operators to
       * ignore exit codes. Dropping an SSE socket is correct: the client reconnects
       * to the replacement process, which is what a redeploy looks like.
       */
      name: "close HTTP and SSE",
      run: () =>
        new Promise<void>((resolve) => {
          const HTTP_DRAIN_GRACE_MS = 3_000;
          let settled = false;
          const done = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(graceTimer);
            resolve();
          };
          httpServer.close(done);
          httpServer.closeIdleConnections?.();
          const graceTimer = setTimeout(() => {
            httpServer.closeAllConnections?.();
            done();
          }, HTTP_DRAIN_GRACE_MS);
        }),
    },
    {
      // 9.
      name: "close MongoDB",
      run: () => mongoExport.close(),
    },
    {
      // 10. LAST: every step above may still have written on its way out.
      name: "close PostgreSQL",
      run: () => closePg(),
    },
  ],
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdownCoordinator.run(signal).then((result) => {
      // The coordinator never calls process.exit itself, so it stays unit-testable.
      process.exit(shutdownExitCode(result));
    });
  });
}

/* ========================================================================== */
/*  LAST-RESORT PROCESS SAFETY NET                                            */
/* ========================================================================== */

/**
 * Node terminates on an unhandled rejection since v15. In a trading backend that
 * turns any stray un-awaited promise into a total outage that drops every SSE client
 * and stops the Box position monitor. The individual offenders have their own
 * `.catch()`; this is the net under them, and it logs LOUDLY so a new offender is
 * obvious rather than invisible.
 *
 * `uncaughtException` is deliberately FATAL: an unknown synchronous throw leaves the
 * process in an undefined state, and pricing or executing trades from there is far
 * more dangerous than exiting into the durable recovery path.
 */
process.on("unhandledRejection", (reason) => {
  console.error(
    "[FATAL-GUARD] Unhandled promise rejection — the process survived, but this is a bug and " +
      "the promise's work did NOT complete:",
    reason,
  );
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception — exiting so the supervisor can restart:", err);
  // No trading state is altered or invented here; open positions are adopted on restart.
  process.exit(1);
});

/** Exported for the shutdown ordering tests, which drive the coordinator directly. */
export { shutdownCoordinator, boot };
