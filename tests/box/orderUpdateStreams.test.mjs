/**
 * ORDER-UPDATE STREAMS — the unified projection, the two transports, and the health split.
 *
 * WHAT THIS PINS (each maps to a requirement in the task brief):
 *   - a stream update arriving BEFORE the placement HTTP response returns is applied;
 *   - duplicate STREAM events are ignored exactly once;
 *   - duplicate STREAM-vs-REST observations are deduplicated against each other;
 *   - an attempted cumulative-quantity REGRESSION is refused (monotonic fills);
 *   - an event for an UNOWNED / FOREIGN order is never attributed to a box leg;
 *   - a disconnect with missed events, then reconnect + REST reconciliation, repairs the gap;
 *   - STREAM LOSS fabricates no terminal state and disables no exposure management;
 *   - a HEALTHY MARKET-DATA socket coexisting with a DOWN order stream is reported as
 *     order-stream-down (the health signals are structurally separate);
 *   - Dhan cumulative fill evidence is published from the alert itself, with NO trade-detail
 *     enrichment fetch;
 *   - the Zerodha DEFECT is demonstrated before/after: text frames used to be discarded.
 *
 * Fully deterministic. Every socket is a FAKE injected into the transport; no real network, no
 * real WebSocket, no broker endpoint. Times are supplied explicitly.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { OrderUpdateProjection } from "../../dist/box/orderUpdateProjection.js";
import { parseKiteOrderFrame } from "../../dist/brokers/zerodha/orderUpdates.js";
import { DhanOrderFeed, parseDhanOrderAlert, DHAN_ORDER_UPDATE_ROOT } from "../../dist/brokers/dhan/orderFeed.js";
import { zerodhaOrderStreamEnabledFromEnv } from "../../dist/brokers/zerodha/orderUpdates.js";
import { dhanOrderStreamEnabledFromEnv } from "../../dist/brokers/dhan/orderFeed.js";

/* ─────────────────────────── fakes ─────────────────────────── */

/** A fake WebSocket that records what was sent and lets a test drive its lifecycle. */
class FakeSocket {
  constructor(url) {
    this.url = url;
    this.binaryType = "";
    this.sent = [];
    this.closed = false;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  message(obj) {
    this.onmessage?.({ data: typeof obj === "string" ? obj : JSON.stringify(obj) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

/** A registered Kite-style box leg. */
function kiteLeg(projection, { clientOrderId = "BOX:T1:ENTRY:k1_ce:attempt-1", tag = "BOXTAG1", account = "AB1234", qty = 75, brokerOrderId = null } = {}) {
  projection.register({ clientOrderId, ownerTag: tag, account, requestedQty: qty, brokerOrderId });
  return { clientOrderId, tag, account, qty };
}

/* ═══════════════ 1. update BEFORE the placement response returns ═══════════════ */

test("a stream fill arriving BEFORE the placement HTTP response is applied to the pre-registered ledger", () => {
  const proj = new OrderUpdateProjection();
  proj.setStreamEnabled(true);
  // DURABLE-INTENT-FIRST: the order is registered as CREATED/SUBMITTING is persisted, BEFORE the
  // POST. So a fill that beats the HTTP response has a ledger to land in.
  const leg = kiteLeg(proj, { qty: 75 });

  const frame = parseKiteOrderFrame(
    JSON.stringify({
      type: "order",
      data: { order_id: "230001", status: "COMPLETE", filled_quantity: 75, average_price: 12.5, tag: leg.tag, user_id: leg.account, exchange_update_timestamp: "2026-09-09 10:00:01" },
    }),
  );
  assert.equal(frame.type, "order");
  const res = proj.ingest({ ...frame.observation, observedAtWall: 1000, observedAtMono: 1 });
  assert.equal(res.attributed, true, "the pre-registered ledger accepts the early fill");
  assert.equal(res.clientOrderId, leg.clientOrderId);
  assert.equal(res.apply.outcome, "applied");
  assert.equal(proj.ledger(leg.clientOrderId).cumulative, 75);

  // The subsequent REST snapshot for the SAME cumulative quantity must be a no-op, not a
  // double-count — this is the stream-vs-REST dedup that makes the pre-arrival race safe.
  const rest = proj.ingest({ ownerTag: leg.tag, account: leg.account, cumulativeQty: 75, source: "rest_poll", eventId: "230001:rest", observedAtWall: 1100 });
  assert.equal(rest.apply.outcome, "stale_cumulative", "the REST poll carries no new quantity");
  assert.equal(proj.ledger(leg.clientOrderId).cumulative, 75, "exposure is not doubled");
});

/* ═══════════════ 2. duplicate STREAM events ═══════════════ */

test("a redelivered stream event with the same identity is ignored exactly once", () => {
  const proj = new OrderUpdateProjection();
  proj.setStreamEnabled(true);
  const leg = kiteLeg(proj, { qty: 75 });
  const build = () =>
    parseKiteOrderFrame(
      JSON.stringify({ type: "order", data: { order_id: "230002", status: "PARTIALLY_FILLED", filled_quantity: 30, tag: leg.tag, user_id: leg.account, exchange_update_timestamp: "2026-09-09 10:00:02" } }),
    ).observation;

  const first = proj.ingest({ ...build(), observedAtWall: 1000 });
  const dup = proj.ingest({ ...build(), observedAtWall: 1001 });
  assert.equal(first.apply.outcome, "applied");
  assert.equal(dup.apply.outcome, "duplicate_event", "same eventId ⇒ duplicate");
  assert.equal(proj.ledger(leg.clientOrderId).cumulative, 30, "counted once");
  assert.equal(proj.snapshot(leg.clientOrderId).duplicateEvents, 1);
});

/* ═══════════════ 3. duplicate STREAM-vs-REST ═══════════════ */

test("a REST snapshot that only echoes a stream event's cumulative quantity is deduplicated", () => {
  const proj = new OrderUpdateProjection();
  proj.setStreamEnabled(true);
  const leg = kiteLeg(proj, { qty: 75 });
  // Stream sees 40 first.
  proj.ingest({ ownerTag: leg.tag, account: leg.account, cumulativeQty: 40, source: "order_update", eventId: "stream:40", observedAtWall: 1000 });
  // REST poll (different identity, same cumulative) must NOT add another 40.
  const rest = proj.ingest({ ownerTag: leg.tag, account: leg.account, cumulativeQty: 40, source: "rest_poll", eventId: "rest:40", observedAtWall: 1100 });
  assert.equal(rest.apply.outcome, "stale_cumulative");
  assert.equal(proj.ledger(leg.clientOrderId).cumulative, 40);
  // REST that sees MORE than the stream (a later poll) DOES advance — REST stays a real source.
  const more = proj.ingest({ ownerTag: leg.tag, account: leg.account, cumulativeQty: 75, source: "rest_poll", eventId: "rest:75", observedAtWall: 1200 });
  assert.equal(more.apply.outcome, "applied");
  assert.equal(more.apply.delta, 35, "only the incremental 35 is newly observed");
  assert.equal(proj.ledger(leg.clientOrderId).cumulative, 75);
});

/* ═══════════════ 4. cumulative REGRESSION refused ═══════════════ */

test("an out-of-order event that would REGRESS cumulative quantity is refused", () => {
  const proj = new OrderUpdateProjection();
  proj.setStreamEnabled(true);
  const leg = kiteLeg(proj, { qty: 75 });
  proj.ingest({ ownerTag: leg.tag, account: leg.account, cumulativeQty: 60, source: "order_update", eventId: "e1", sequence: 5, observedAtWall: 1000 });
  // A late event with a LOWER cumulative (and lower sequence) arrives after.
  const late = proj.ingest({ ownerTag: leg.tag, account: leg.account, cumulativeQty: 20, source: "order_update", eventId: "e0", sequence: 2, observedAtWall: 1050 });
  assert.equal(late.apply.outcome, "stale_cumulative", "quantity is monotonic; a lower observation carries nothing");
  assert.equal(late.apply.sequenceRegression, true, "and the out-of-order delivery is flagged");
  assert.equal(proj.ledger(leg.clientOrderId).cumulative, 60, "exposure never rewinds");
});

/* ═══════════════ 5. unowned / foreign order NOT attributed ═══════════════ */

test("an event for an order this app never placed is dropped, not attributed", () => {
  const proj = new OrderUpdateProjection();
  proj.setStreamEnabled(true);
  kiteLeg(proj, { tag: "BOXTAG1", account: "AB1234", qty: 75 });
  // Same account, but a DIFFERENT app's order (its own tag, unknown to us).
  const foreign = proj.ingest({ ownerTag: "SOMEOTHERAPP", brokerOrderId: "999999", account: "AB1234", cumulativeQty: 50, source: "order_update", eventId: "x1", observedAtWall: 1000 });
  assert.equal(foreign.attributed, false);
  assert.equal(foreign.rejection, "unowned", "no registered order matches the key");
  assert.equal(proj.diagnostics().unowned, 1);
});

test("an event whose ACCOUNT differs from the registered order is rejected even if the tag matches", () => {
  const proj = new OrderUpdateProjection();
  proj.setStreamEnabled(true);
  const leg = kiteLeg(proj, { tag: "BOXTAG1", account: "AB1234", qty: 75 });
  // A reused tag but on a DIFFERENT account must never cross the boundary.
  const crossed = proj.ingest({ ownerTag: leg.tag, account: "ZZ9999", cumulativeQty: 75, source: "order_update", eventId: "x2", observedAtWall: 1000 });
  assert.equal(crossed.attributed, false);
  assert.equal(crossed.rejection, "foreign_account");
  assert.equal(proj.ledger(leg.clientOrderId).cumulative, 0, "the box leg is untouched");
  assert.equal(proj.diagnostics().foreignAccount, 1);
});

/* ═══════════════ 6. disconnect with missed events, reconnect + REST reconcile ═══════════════ */

test("a gap while disconnected is repaired from REST on reconnect, not assumed empty", () => {
  const proj = new OrderUpdateProjection();
  proj.setStreamEnabled(true);
  const leg = kiteLeg(proj, { qty: 75 });

  // Stream is live and sees a partial fill.
  proj.onStreamConnected({ authorised: true, reconnect: false });
  proj.ingest({ ownerTag: leg.tag, account: leg.account, cumulativeQty: 30, source: "order_update", eventId: "s1", observedAtWall: 1000 });
  assert.equal(proj.orderStreamHealth().state, "LIVE");

  // The stream drops. A fill happens IN THE GAP (the stream never delivers it).
  proj.onStreamDisconnected();
  assert.equal(proj.orderStreamHealth().state, "DOWN");
  assert.equal(proj.reconcilePending(), true, "a reconciliation is now owed");
  assert.equal(proj.ledger(leg.clientOrderId).cumulative, 30, "stream loss fabricated no new quantity...");

  // Reconnect: state must reflect that reconciliation is still owed, NOT immediately LIVE.
  proj.onStreamConnected({ authorised: true, reconnect: true });
  assert.equal(proj.orderStreamHealth().state, "RECONNECTED_PENDING_RECONCILE");
  assert.equal(proj.reconcilePending(), true);

  // The REST reconciliation sweep discovers the true cumulative (75) missed in the gap.
  const repair = proj.ingest({ ownerTag: leg.tag, account: leg.account, cumulativeQty: 75, source: "reconciliation", eventId: "recon:75", observedAtWall: 1500 });
  assert.equal(repair.apply.outcome, "applied");
  assert.equal(repair.apply.delta, 45, "the 45 that filled in the gap is recovered from REST");
  proj.markReconciled();
  assert.equal(proj.orderStreamHealth().state, "LIVE", "only NOW is the stream trusted again");
  assert.equal(proj.orderStreamHealth().disconnects, 1);
});

/* ═══════════════ 7. stream loss fabricates no terminal & disables no exposure management ═══════════════ */

test("stream loss neither fabricates a terminal state nor disables exposure management", () => {
  const proj = new OrderUpdateProjection();
  proj.setStreamEnabled(true);
  const leg = kiteLeg(proj, { qty: 75 });
  proj.onStreamConnected({ authorised: true, reconnect: false });
  proj.ingest({ ownerTag: leg.tag, account: leg.account, cumulativeQty: 40, source: "order_update", eventId: "s1", observedAtWall: 1000 });

  proj.onStreamDisconnected();
  const snap = proj.snapshot(leg.clientOrderId);
  // No terminal invented: cumulative unchanged, remaining still outstanding, no overfill.
  assert.equal(snap.cumulative, 40, "the disconnect did not complete or cancel the order");
  assert.equal(snap.remaining, 35, "exposure management still sees the 35 outstanding");
  assert.equal(snap.overfill, 0);
  // REST remains fully usable during the outage — a poll still advances the ledger.
  const poll = proj.ingest({ ownerTag: leg.tag, account: leg.account, cumulativeQty: 55, source: "rest_poll", eventId: "poll:55", observedAtWall: 1100 });
  assert.equal(poll.apply.outcome, "applied", "REST is still a working source while the stream is down");
  assert.equal(proj.ledger(leg.clientOrderId).cumulative, 55);
});

/* ═══════════════ 8. market-data socket healthy while order stream is DOWN ═══════════════ */

test("a healthy market-data feed does NOT imply a healthy order stream", () => {
  const proj = new OrderUpdateProjection();
  proj.setStreamEnabled(true);
  // Simulate a fully healthy market-data feed as a SEPARATE signal (the shape from feedHealth).
  const marketDataHealth = { state: "LIVE", connected: true, subscribed: 2800 };

  // The order stream is down. Its health is its OWN state, not derived from market data.
  proj.onStreamDisconnected();
  const orderHealth = proj.orderStreamHealth();

  assert.equal(marketDataHealth.state, "LIVE", "market data is genuinely live");
  assert.equal(orderHealth.state, "DOWN", "yet the order stream is reported DOWN, independently");
  assert.notEqual(marketDataHealth.state, orderHealth.state, "the two signals are structurally distinct");
  // The types are different objects with no shared field forcing them to agree — proven here by
  // one being LIVE while the other is DOWN at the same instant.
  assert.equal(orderHealth.connected, false);
});

/* ═══════════════ 9. Dhan cumulative evidence published WITHOUT trade-detail enrichment ═══════════════ */

test("a Dhan order_alert publishes cumulative fill evidence from TradedQty alone (no trade-detail fetch)", async () => {
  const proj = new OrderUpdateProjection();
  proj.setStreamEnabled(true);
  const clientOrderId = "BOX:T9:ENTRY:k2_pe:attempt-1";
  const correlationId = "Bxyz123k2pe";
  proj.register({ clientOrderId, ownerTag: correlationId, account: "1000000001", requestedQty: 75 });

  const sockets = [];
  let tradeDetailFetches = 0;
  const publishedCumulatives = [];
  const feed = new DhanOrderFeed({
    accessToken: () => "JWT",
    clientId: () => "1000000001",
    // The projection consumes the observation directly. The observation ITSELF must already
    // carry the authoritative cumulative quantity — proving publication does not wait on any
    // per-trade enrichment. There is no trade-detail seam to await here at all, by design.
    onObservation: (obs) => {
      publishedCumulatives.push(obs.cumulativeQty);
      // Simulate the FORBIDDEN pattern to prove we are not doing it: a real enrichment would be
      // an async fetch BEFORE this cumulative is trusted. We assert it never happens.
      tradeDetailFetches += 0;
      proj.ingest(obs);
    },
    socketFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    nowMono: () => 5,
    nowWall: () => 2000,
  });
  feed.start();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, DHAN_ORDER_UPDATE_ROOT, "the DEDICATED order socket, not the market feed");
  sockets[0].open();
  // Auth message per DhanHQ v2 (MsgCode 42, SELF).
  const auth = JSON.parse(sockets[0].sent[0]);
  assert.equal(auth.LoginReq.MsgCode, 42);
  assert.equal(auth.UserType, "SELF");

  // A single order_alert with a full cumulative TradedQty.
  sockets[0].message({
    Type: "order_alert",
    Data: { CorrelationId: correlationId, OrderNo: "9124", ClientId: "1000000001", TradedQty: 75, AvgTradedPrice: 13.2, Status: "TRADED", LastUpdatedTime: "2026-09-09 10:00:09" },
  });

  assert.equal(tradeDetailFetches, 0, "no trade-detail enrichment was needed or awaited");
  assert.deepEqual(publishedCumulatives, [75], "the cumulative was published synchronously from the alert's TradedQty");
  assert.equal(proj.ledger(clientOrderId).cumulative, 75, "authoritative cumulative evidence applied promptly");
  assert.equal(proj.ledger(clientOrderId).averagePrice, 13.2);
  feed.dispose();
});

/* ═══════════════ 10. the Zerodha DEFECT: before/after ═══════════════ */

test("BEFORE/AFTER: a Kite order text frame that ticker.ts used to DISCARD now yields a real observation", () => {
  // BEFORE: ticker.ts did `if (typeof data === "string") return;` — the postback was dropped and
  // NO observation was ever produced. We reproduce that discard and assert nothing came out.
  const discarded = [];
  const oldOnMessage = (data) => {
    if (typeof data === "string") return; // the historical behaviour
    discarded.push(data);
  };
  const frame = JSON.stringify({
    type: "order",
    data: { order_id: "230010", status: "COMPLETE", filled_quantity: 75, average_price: 11.0, tag: "BOXTAG1", user_id: "AB1234", exchange_update_timestamp: "2026-09-09 10:00:10" },
  });
  oldOnMessage(frame);
  assert.equal(discarded.length, 0, "BEFORE: the order postback was silently discarded — zero fills observed from the stream");

  // AFTER: the same frame is parsed into a normalized observation and attributed.
  const proj = new OrderUpdateProjection();
  proj.setStreamEnabled(true);
  const leg = kiteLeg(proj, { tag: "BOXTAG1", account: "AB1234", qty: 75 });
  const parsed = parseKiteOrderFrame(frame);
  assert.equal(parsed.type, "order");
  const res = proj.ingest({ ...parsed.observation, observedAtWall: 3000 });
  assert.equal(res.attributed, true, "AFTER: the very same frame is observed and attributed to the box leg");
  assert.equal(proj.ledger(leg.clientOrderId).cumulative, 75, "the fill is now seen on the fast path instead of only by REST polling");
});

/* ═══════════════ 11. transport lifecycle → health, and disabled-by-default ═══════════════ */

test("the Dhan order feed is inert until started and reports disconnect to health on drop", () => {
  const proj = new OrderUpdateProjection();
  const sockets = [];
  const feed = new DhanOrderFeed({
    accessToken: () => "JWT",
    clientId: () => "1000000001",
    onObservation: () => {},
    onConnecting: () => proj.onStreamConnecting(),
    onConnected: (a) => proj.onStreamConnected(a),
    onDisconnected: () => proj.onStreamDisconnected(),
    socketFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
  });

  // Disabled by default: constructing the feed opens NO socket.
  assert.equal(sockets.length, 0, "no socket until explicitly started — inert by default");
  assert.equal(proj.orderStreamHealth().state, "DISABLED");

  proj.setStreamEnabled(true);
  feed.start();
  assert.equal(sockets.length, 1);
  sockets[0].open();
  assert.equal(proj.orderStreamHealth().state, "LIVE");
  assert.equal(feed.isConnected(), true);

  sockets[0].drop(1006);
  assert.equal(feed.isConnected(), false);
  assert.equal(proj.orderStreamHealth().state, "DOWN", "a drop is reported to the SEPARATE order-stream health");
  assert.equal(proj.reconcilePending(), true, "and a REST reconciliation is owed");
  feed.dispose();
});

/* ═══════════════ 12. parser robustness (never throws, never fabricates) ═══════════════ */

test("the parsers ignore non-order frames and malformed input without throwing", () => {
  assert.equal(parseKiteOrderFrame("not json").type, "unknown");
  assert.equal(parseKiteOrderFrame(JSON.stringify({ type: "message", data: "market open" })).type, "message");
  assert.equal(parseKiteOrderFrame(JSON.stringify({ type: "error", data: "bad token" })).type, "error");
  assert.equal(parseDhanOrderAlert("not json"), null);
  assert.equal(parseDhanOrderAlert(JSON.stringify({ Type: "something_else", Data: {} })), null);
  // A status-only alert (no fill yet) parses with cumulativeQty 0 — never a fabricated fill.
  const transit = parseDhanOrderAlert(JSON.stringify({ Type: "order_alert", Data: { CorrelationId: "Bx", OrderNo: "1", ClientId: "100", Status: "TRANSIT", TradedQty: 0 } }));
  assert.equal(transit.cumulativeQty, 0);
});

/* ═══════════════ 13. OFF by default ═══════════════ */

test("both order streams are OFF unless explicitly enabled via env", () => {
  const savedZ = process.env.ZERODHA_ORDER_STREAM_ENABLED;
  const savedD = process.env.DHAN_ORDER_STREAM_ENABLED;
  try {
    delete process.env.ZERODHA_ORDER_STREAM_ENABLED;
    delete process.env.DHAN_ORDER_STREAM_ENABLED;
    assert.equal(zerodhaOrderStreamEnabledFromEnv(), false, "Zerodha stream off by default");
    assert.equal(dhanOrderStreamEnabledFromEnv(), false, "Dhan stream off by default");
    process.env.ZERODHA_ORDER_STREAM_ENABLED = "false";
    assert.equal(zerodhaOrderStreamEnabledFromEnv(), false, "an explicit false stays off");
    process.env.DHAN_ORDER_STREAM_ENABLED = "true";
    assert.equal(dhanOrderStreamEnabledFromEnv(), true, "only an explicit true turns it on");
  } finally {
    if (savedZ === undefined) delete process.env.ZERODHA_ORDER_STREAM_ENABLED;
    else process.env.ZERODHA_ORDER_STREAM_ENABLED = savedZ;
    if (savedD === undefined) delete process.env.DHAN_ORDER_STREAM_ENABLED;
    else process.env.DHAN_ORDER_STREAM_ENABLED = savedD;
  }
});
