/**
 * Trades, crash recovery and the one-shot session against a real PostgreSQL.
 *
 * These prove the SQL guarantees that replace the Mongo ones: the partial unique index
 * refusing a duplicate open box, the CHECK/guard preventing a partial exit from
 * over-closing, the durable order-intent ledger surviving each crash window, restart
 * adoption of unresolved intents/attempts, the single-unresolved crash-recovery index,
 * and the one-shot trading session surviving a restart.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, loadRepository, baseIntent, baseTrade, audit } from "./helpers.mjs";

let ctx;
let repo;

test.before(async () => {
  ctx = await setup("trades");
  repo = await loadRepository();
});
test.after(async () => { await teardown(ctx); });

test("duplicate open box on the same pair/direction/broker is refused by the partial unique index", async () => {
  const t = baseTrade({ lower_strike: 24000, upper_strike: 24200 });
  const first = await repo.insertBoxTrade(t);
  assert.ok(first, "first open box inserts");
  // A second open box on the identical (broker, underlying, expiry, strikes, direction).
  const second = await repo.insertBoxTrade(baseTrade({ lower_strike: 24000, upper_strike: 24200 }));
  assert.equal(second, null, "the duplicate open box must be refused (null), not thrown");
  // A DIFFERENT direction on the same strikes is a distinct position and is allowed.
  const shortBox = await repo.insertBoxTrade(baseTrade({ lower_strike: 24000, upper_strike: 24200, direction: "SHORT_BOX" }));
  assert.ok(shortBox, "opposite direction on the same strikes is a distinct open box");
});

test("closed box frees the pair so it can be opened again", async () => {
  const t = await repo.insertBoxTrade(baseTrade({ lower_strike: 26000, upper_strike: 26200 }));
  const closed = await repo.closeBoxTrade(t._id, { status: "closed", closed_at: new Date(), net_pnl: 3 });
  assert.ok(closed && closed.status === "closed");
  const reopened = await repo.insertBoxTrade(baseTrade({ lower_strike: 26000, upper_strike: 26200 }));
  assert.ok(reopened, "the same pair can be reopened once the prior box closed");
});

test("partial-exit over-close is prevented by the intent quantity guard", async () => {
  // A fill can never exceed the order quantity (box_order_intents_filled_le_qty CHECK),
  // which is the durable half of over-close prevention.
  const coid = `BOX:${Math.random().toString(36).slice(2)}:EXIT:k1_ce:a1`;
  await repo.createBoxOrderIntent(baseIntent({ client_order_id: coid, quantity: 75, state: "OPEN", purpose: "EXIT", phase: "exit" }));
  await assert.rejects(
    () => repo.updateBoxOrderIntent(coid, { state: "PARTIALLY_FILLED", filled_quantity: 80 }, audit("PARTIALLY_FILLED")),
    /check|constraint|violat/i,
    "a fill exceeding the order quantity must be rejected by the CHECK constraint",
  );
});

test("crash BEFORE POST: intent is durable at CREATED before any broker call", async () => {
  const coid = `BOX:${Math.random().toString(36).slice(2)}:ENTRY:k2_ce:a1`;
  await repo.createBoxOrderIntent(baseIntent({ client_order_id: coid, state: "CREATED" }));
  // Simulate a crash immediately after createBoxOrderIntent, before SUBMITTING.
  const recovered = await repo.findBoxOrderIntentByClientId(coid);
  assert.ok(recovered, "the intent must be durable before submission");
  assert.equal(recovered.state, "CREATED");
  assert.ok(repo.loadNonterminalBoxOrderIntents, "reconciliation can re-read it");
  const nonterminal = await repo.loadNonterminalBoxOrderIntents();
  assert.ok(nonterminal.some((i) => i.client_order_id === coid));
});

test("crash AFTER POST before response: broker_order_id + SUBMITTING is durable and re-readable by broker id", async () => {
  const coid = `BOX:${Math.random().toString(36).slice(2)}:ENTRY:k2_pe:a1`;
  await repo.createBoxOrderIntent(baseIntent({ client_order_id: coid, state: "SUBMITTING" }));
  await repo.updateBoxOrderIntent(coid, { state: "ACKNOWLEDGED", broker_order_id: "POSTED-1" }, audit("ACKNOWLEDGED"));
  // Crash before the ACK response was processed; restart reconciliation finds it by broker id.
  const byBroker = await repo.findBoxOrderIntentByBrokerId("POSTED-1");
  assert.ok(byBroker, "the posted order must be recoverable by broker order id");
  assert.equal(byBroker.state, "ACKNOWLEDGED");
});

test("crash AFTER a partial fill: cumulative filled quantity is durable and monotonic across restart", async () => {
  const coid = `BOX:${Math.random().toString(36).slice(2)}:ENTRY:k1_pe:a1`;
  await repo.createBoxOrderIntent(baseIntent({ client_order_id: coid, state: "OPEN", quantity: 75, filled_quantity: 0 }));
  await repo.updateBoxOrderIntent(coid, { state: "PARTIALLY_FILLED", filled_quantity: 40 }, audit("PARTIALLY_FILLED"));
  // Simulate restart: re-read, then a stale snapshot tries to regress to 20 — rejected.
  const afterRestart = await repo.findBoxOrderIntentByClientId(coid);
  assert.equal(afterRestart.filled_quantity, 40);
  const regress = await repo.updateBoxOrderIntent(coid, { state: "PARTIALLY_FILLED", filled_quantity: 20 }, audit("PARTIALLY_FILLED"));
  assert.equal(regress.applied, false, "a stale lower fill cannot regress the durable cumulative quantity");
  assert.equal((await repo.findBoxOrderIntentByClientId(coid)).filled_quantity, 40);
});

test("restart adoption: owned live intents are re-loaded whole", async () => {
  const coid = `BOX:${Math.random().toString(36).slice(2)}:ENTRY:k1_ce:adopt`;
  await repo.createBoxOrderIntent(baseIntent({ client_order_id: coid, state: "OPEN", trade_id: "adopt-trade" }));
  const owned = await repo.loadOwnedBoxOrderIntents();
  assert.ok(owned.some((i) => i.client_order_id === coid), "owned live intents must be adoptable on restart");
});

test("single unresolved crash-recovery attempt: the partial unique index admits exactly one", async () => {
  // Establish and verify the crash-recovery persistence boundary.
  await repo.initialiseBoxExecutionAttemptPersistence();
  assert.equal(repo.isBoxRecoveryPersistenceReady(), true);
  const residual = [{ token: 9001, tradingsymbol: "SYM-k1_ce", exchange: "NFO", role: "k1_ce", side: "SELL", quantity: 75 }];
  const a = await repo.ensureBoxRecoveryExecutionAttempt({
    id: repo.allocateBoxTradeId(), recoveryKey: repo.BOX_RECOVERY_KEY, residual,
    executionMode: "live", broker: "zerodha", at: new Date(),
  });
  assert.ok(a, "first crash-recovery attempt is created");
  // A second attempt with a different id must ADOPT the same row, never mint a competitor.
  const b = await repo.ensureBoxRecoveryExecutionAttempt({
    id: repo.allocateBoxTradeId(), recoveryKey: repo.BOX_RECOVERY_KEY, residual,
    executionMode: "live", broker: "zerodha", at: new Date(),
  });
  assert.ok(b);
  assert.equal(a._id, b._id, "there is exactly one unresolved crash-recovery boundary");
});

test("one-shot trading session survives a restart", async () => {
  const record = {
    session_id: "sess-1", armed_at: Date.now(), armed_by: "operator",
    max_completed_trades: 1, established_trade_ids: ["t1"], completed_trade_ids: [],
    aborted_attempts: 0, arm_count: 1, updated_at: Date.now(),
  };
  await repo.saveBoxTradingSession(record);
  // Simulate restart: re-read the durable record.
  const loaded = await repo.loadBoxTradingSession();
  assert.equal(loaded.ok, true);
  assert.ok(loaded.record);
  assert.equal(loaded.record.session_id, "sess-1");
  assert.equal(loaded.record.max_completed_trades, 1);
  assert.deepEqual(loaded.record.established_trade_ids, ["t1"]);
  // A consumed cycle stays consumed: mark completed and confirm it persists.
  await repo.saveBoxTradingSession({ ...record, completed_trade_ids: ["t1"] });
  const after = await repo.loadBoxTradingSession();
  assert.deepEqual(after.record.completed_trade_ids, ["t1"]);
});
