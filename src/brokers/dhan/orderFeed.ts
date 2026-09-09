/**
 * DHAN LIVE ORDER-UPDATE STREAM — the DEDICATED order socket.
 *
 * This is a SEPARATE socket from the market feed. Per the current DhanHQ v2 documentation
 * (verified 2026-09-09, https://dhanhq.co/docs/v2/order-update/):
 *   - market data:   wss://api-feed.dhan.co        (src/brokers/dhan/feed.ts)
 *   - order updates: wss://api-order-update.dhan.co (this file)
 * Conflating them is a category error: a healthy market feed says nothing about whether order
 * updates are being delivered, which is exactly why order-stream health is tracked apart from
 * feed health (see box/orderUpdateProjection.ts).
 *
 * AUTHORISATION. On open, an individual client sends:
 *   { "LoginReq": { "MsgCode": 42, "ClientId": "<id>", "Token": "<jwt>" }, "UserType": "SELF" }
 *
 * MESSAGE. Each update is JSON: { "Type": "order_alert", "Data": { … } }. The `Data` payload
 * carries `TradedQty` (CUMULATIVE executed quantity), `AvgTradedPrice`, `Status`,
 * `CorrelationId` (our strategy key, echoed back), `OrderNo` (Dhan order id) and `ClientId`
 * (the account). PROMPT PUBLICATION: `TradedQty` is authoritative cumulative fill evidence and
 * is present on the alert itself — this transport NEVER blocks publication on a follow-up
 * trade-detail (`getTradesForOrder`) request. That enrichment is per-trade granularity only;
 * exposure is fully determined by the cumulative quantity already in hand.
 *
 * SAFETY. Order updates NEVER trigger an order — this is an observe-only socket. It is inert
 * unless explicitly enabled (the registry gates it exactly like live behaviour elsewhere), and
 * the WebSocket constructor is injectable so tests drive it with a fake and never open a real
 * socket.
 */

import type { NormalizedOrderObservation } from "../../box/orderUpdateProjection.js";

export const DHAN_ORDER_UPDATE_ROOT = "wss://api-order-update.dhan.co";

/** Dhan's message code for the order-update login request. `42` per the v2 docs. */
const ORDER_UPDATE_MSG_CODE = 42;

/** Minimal structural WebSocket type — the backend targets esnext with no DOM lib. */
interface MinimalWebSocket {
  binaryType: string;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((ev: { code?: number }) => void) | null;
}

type WebSocketFactory = (url: string) => MinimalWebSocket;

export interface DhanOrderFeedOptions {
  /** Read fresh on every connect: a reconnect must use the CURRENT token. Null ⇒ no session. */
  accessToken: () => string | null;
  clientId: () => string;
  /** Called with every normalized order observation (already carries times). */
  onObservation: (observation: NormalizedOrderObservation) => void;
  /** Connection lifecycle, so the projection can track order-stream health separately. */
  onConnecting?: () => void;
  onConnected?: (args: { authorised: boolean; reconnect: boolean }) => void;
  onDisconnected?: () => void;
  /** Fatal/auth failures: the session is unusable and must be re-established. */
  onSessionLost?: (reason: string) => void;
  /** Monotonic + wall clocks, injected so observations are stamped deterministically. */
  nowMono?: () => number;
  nowWall?: () => number;
  /**
   * WebSocket factory. Injected by tests with a fake; production passes a real-socket factory.
   * Absent ⇒ uses the global `WebSocket` (Node 21+/undici) — but a test must NEVER let it reach
   * that path.
   */
  socketFactory?: WebSocketFactory;
  /** Reconnect backoff bounds (ms). Defaulted to match the market feed's shape. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export class DhanOrderFeed {
  private ws: MinimalWebSocket | null = null;
  private connected = false;
  private disposed = false;
  private enabled = false;
  /** True once we have connected at least once, so the NEXT connect is a reconnect. */
  private everConnected = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: DhanOrderFeedOptions) {}

  private nowMono(): number {
    return this.opts.nowMono?.() ?? (typeof performance !== "undefined" ? performance.now() : Date.now());
  }

  private nowWall(): number {
    return this.opts.nowWall?.() ?? Date.now();
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Enable and open the socket. Inert until called — the stream is OFF by default so a
   * misconfiguration cannot open an order socket unbidden. Idempotent.
   */
  start(): void {
    if (this.disposed) return;
    this.enabled = true;
    this.ensureSocket();
  }

  private ensureSocket(): void {
    if (this.disposed || !this.enabled || this.ws) return;
    const token = this.opts.accessToken();
    const clientId = this.opts.clientId();
    if (!token || !clientId) return; // no session yet; the caller retries when one exists

    this.opts.onConnecting?.();
    const factory = this.opts.socketFactory ?? defaultFactory;
    let ws: MinimalWebSocket;
    try {
      ws = factory(DHAN_ORDER_UPDATE_ROOT);
    } catch (err) {
      this.scheduleReconnect(`socket construction failed: ${String(err)}`);
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    // Every handler is guarded on socket identity so a superseded socket can never emit into
    // the live projection — the same discipline the market feed uses.
    ws.onopen = () => {
      if (this.ws !== ws) return;
      const wasReconnect = this.everConnected;
      this.connected = true;
      this.everConnected = true;
      this.reconnectAttempts = 0;
      // AUTHORISE. Until this is accepted, updates will not flow. We optimistically report
      // connected+authorised here because Dhan does not send an explicit auth-ack frame; a
      // rejected auth manifests as an onclose with an auth code, handled below.
      try {
        ws.send(
          JSON.stringify({
            LoginReq: { MsgCode: ORDER_UPDATE_MSG_CODE, ClientId: clientId, Token: token },
            UserType: "SELF",
          }),
        );
      } catch (err) {
        this.opts.onSessionLost?.(`Dhan order-update auth send failed: ${String(err)}`);
        return;
      }
      // reconnect ⇒ a reconciliation is owed: fills may have happened while we were away.
      this.opts.onConnected?.({ authorised: true, reconnect: wasReconnect });
    };

    ws.onmessage = (ev: { data: unknown }) => {
      if (this.ws !== ws) return;
      // Dhan order updates are JSON text; binary here would be unexpected and is ignored.
      const data = ev.data;
      const raw = typeof data === "string" ? data : null;
      if (raw === null) return;
      const observation = parseDhanOrderAlert(raw);
      if (observation === null) return;
      this.opts.onObservation({
        ...observation,
        observedAtMono: this.nowMono(),
        observedAtWall: this.nowWall(),
      });
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      // `onclose` always follows; recovery is driven from there to avoid double-scheduling.
    };

    ws.onclose = (ev: { code?: number }) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.opts.onDisconnected?.();
      const code = ev.code ?? 0;
      if (isAuthClose(code)) {
        this.opts.onSessionLost?.(
          `Dhan order-update stream rejected the session (close code ${code}) — the token is invalid or expired.`,
        );
        return;
      }
      this.scheduleReconnect(`socket closed (code ${code})`);
    };
  }

  private scheduleReconnect(reason: string): void {
    if (this.disposed || !this.enabled || this.reconnectTimer) return;
    this.reconnectAttempts++;
    const base = this.opts.reconnectBaseMs ?? 500;
    const max = this.opts.reconnectMaxMs ?? 15_000;
    const delay = Math.min(max, base * 2 ** Math.min(6, this.reconnectAttempts - 1));
    console.warn(`[DhanOrderFeed] ${reason}; reconnecting in ${delay}ms.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /** Stop the socket. Does NOT fabricate a terminal state for any order — it only observes. */
  stop(): void {
    this.enabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    const wasConnected = this.connected;
    this.connected = false;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    if (wasConnected) this.opts.onDisconnected?.();
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }
}

/** The subset of the Dhan order_alert `Data` payload this projection needs. */
interface DhanOrderAlertData {
  CorrelationId?: unknown;
  OrderNo?: unknown;
  ClientId?: unknown;
  TradedQty?: unknown;
  AvgTradedPrice?: unknown;
  Status?: unknown;
  LastUpdatedTime?: unknown;
  ExchOrderTime?: unknown;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Parse one Dhan `order_alert` frame into a normalized observation (WITHOUT times — the caller
 * stamps them). Returns null for a non-order or malformed frame; NEVER throws, because a
 * malformed frame must not tear down the order socket.
 *
 * `TradedQty` is the CUMULATIVE executed quantity and is authoritative for exposure. There is
 * no follow-up fetch: everything needed to attribute and to apply is in this single frame.
 */
export function parseDhanOrderAlert(raw: string): NormalizedOrderObservation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const frame = parsed as { Type?: unknown; Data?: unknown };
  if (frame.Type !== "order_alert" || typeof frame.Data !== "object" || frame.Data === null) {
    return null;
  }
  const data = frame.Data as DhanOrderAlertData;
  const correlationId = str(data.CorrelationId);
  const orderNo = str(data.OrderNo);
  const account = str(data.ClientId);
  const traded = num(data.TradedQty);
  const avg = num(data.AvgTradedPrice);
  const status = str(data.Status);
  // No per-alert sequence number is provided. LastUpdatedTime + cumulative qty distinguishes
  // two genuinely-distinct alerts for the same order; the monotonic ledger handles ordering.
  const stamp = str(data.LastUpdatedTime) ?? str(data.ExchOrderTime);
  const eventId = orderNo && stamp ? `${orderNo}:${stamp}:${traded ?? "?"}` : null;

  return {
    ownerTag: correlationId ?? "",
    brokerOrderId: orderNo,
    account,
    // A status-only alert (e.g. TRANSIT/PENDING before any fill) reports TradedQty 0, which the
    // monotonic ledger treats as carrying no new quantity — it can never rewind a prior fill.
    cumulativeQty: traded ?? 0,
    averagePrice: avg,
    rawStatus: status,
    eventId,
    source: "order_update",
  };
}

/** Close codes that mean "this session will never work", so retrying is pointless. */
function isAuthClose(code: number): boolean {
  return code === 1008 || code === 4001 || code === 4401 || code === 4403;
}

function defaultFactory(url: string): MinimalWebSocket {
  // Node 21+/undici provides a global WebSocket. Cast through the minimal shape; a test must
  // never reach this path (the hermetic guard and injected fakes ensure that).
  const Ctor = (globalThis as { WebSocket?: new (url: string) => MinimalWebSocket }).WebSocket;
  if (!Ctor) throw new Error("No global WebSocket available for the Dhan order-update stream.");
  return new Ctor(url);
}
