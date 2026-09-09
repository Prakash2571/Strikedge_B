# HANDOFF — transport agent

Changes I could NOT make myself (files owned by other agents), with exact change and rationale.
The transport fixes are designed to work WITHOUT these; they are improvements for the owning agent
to consider.

## To the hedge agent (owns orderManager.ts, liveEntryGuard.ts, executionGateway.ts, executionCoordinator.ts)

1. `BeforeBrokerPost` contract is UNCHANGED and preserved: it remains a synchronous callback that
   signals refusal by THROWING `BrokerPreSubmitRefusedError`. Transport now guarantees the guard is
   invoked at the FINAL SYNCHRONOUS instant before the network `fetch()` — after ALL pacing/queue
   waits, not before them. Callers pass it exactly as before (`submitOrder(req, beforePost)`).
   No action required, but note: the guard may now be called slightly LATER in wall-clock time than
   it used to be (after the lower HTTP pacing queue drains), which is the entire point — it closes
   the window in which a queued POST could fire after entry was disarmed.

2. OPTIONAL, non-blocking: `submitOrder` may now reject with `BrokerPreSubmitRefusedError` whose
   `stage` is `"pre_post"` in strictly more situations (a guard that throws because the entry
   DEADLINE expired while the POST sat in the lower pacing queue). This is still a proven-no-POST
   local refusal and must be treated as terminal identity spend, exactly as today. No code change
   needed; the error type and meaning are identical.

## To the pacing agent (owns brokerPacing.ts, boxCapital.ts, brokerContext.ts)

3. `TransportPacer.run` is used unchanged. Transport did NOT modify pacing arithmetic. The Dhan
   lower-layer HTTP pacing (`DHAN_MIN_INTERVAL_MS` in src/brokers/dhan/http.ts) still exists and
   still matches the Dhan order floor in brokerPacing.ts (120ms) — that invariant is preserved.

   OBSERVATION (no change requested): the adapter-level `TransportPacer` and the Dhan HTTP-level
   pacer both impose a wait before a POST. The transport now carries an absolute monotonic deadline
   THROUGH both so that a POST which has become too old to be useful is refused before transmission
   rather than sent late. If the pacing agent ever wants to expose the HTTP-level queue depth in
   diagnostics, the Dhan http layer now tracks it internally (`DhanHttp` queue) and could surface it.

## Config (src/box/config.ts, owned — NOT modified)

4. No new config knob was required. The transport reuses existing knobs:
   - `liveHttpTimeoutMs` (BOX_LIVE_HTTP_TIMEOUT_MS) — per-request network+body deadline for Kite.
   - `DHAN_HTTP_TIMEOUT_MS` — per-request network+body deadline for Dhan (existing).
   The end-to-end deadline is derived from these; no schema change needed.
