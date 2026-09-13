/**
 * THE DHAN ORDER-STREAM LIFECYCLE WIRING — extracted so the PRODUCTION path is the TESTED path.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT WAS WRONG
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The Dhan branch of `engine.startOrderStreamTransports()` built the feed's callbacks inline:
 *
 *     onConnected: (args) => {
 *       consumer.onSocketOpen();
 *       if (args.authorised) consumer.onAuthenticated();
 *     },
 *
 * `onAuthenticated()` ALWAYS owes a reconciliation and lands the lifecycle in RECONCILING, and
 * `markSynchronized()` is the ONLY way out of RECONCILING. Nothing here started a reconciliation. So
 * a Dhan deployment connected, authorised, entered RECONCILING — and stayed there. Since
 * `ORDER_STREAM_PERMISSIONS.RECONCILING.newEntry === false`, the live entry checkpoint refused every
 * box forever with `feed_unhealthy` naming `order-stream RECONCILING`. Nothing crashed and nothing
 * logged an error; entry simply never happened. Zerodha was unaffected because its postbacks ride the
 * quote socket and go through `consumer.driveQuoteSocketLifecycle()`, which DOES drive the sweep.
 *
 * The only accidental escape was a stream event with an ABSENT quantity, which scheduled a TARGETED
 * single-order REST reconcile whose callback then called `markSynchronized()` — an account-wide
 * readiness claim built on one order's evidence. That back door has been closed too (see
 * `restReconcile` in engine.ts), which is what makes this wiring load-bearing rather than redundant.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY IT LIVES IN ITS OWN MODULE
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * The defect survived a 2,000-test suite because the only Dhan lifecycle coverage drove the consumer
 * BY HAND (`tests/box/streamGovernance.test.mjs` calls `runReconnectReconciliation()` itself), so it
 * asserted the consumer's behaviour and never the engine's wiring of it. A test cannot reach into
 * `engine.startOrderStreamTransports()` without a live adapter, PostgreSQL and a broker session.
 * Exporting the handler factory makes the REAL production callbacks — the exact object the engine
 * hands to `createDhanOrderFeed` — directly drivable by a test with a fake socket. The engine now has
 * no Dhan lifecycle logic of its own to drift from.
 */

import type { OrderStreamConsumer } from "./orderStreamConsumer.js";
import type { NormalizedOrderObservation } from "./orderUpdateProjection.js";

/**
 * The subset of `DhanOrderFeedOptions` that describes the lifecycle wiring. Structural on purpose:
 * this module must not import the transport (the transport imports nothing from the box engine, and
 * keeping it that way avoids a cycle).
 */
export interface DhanOrderStreamHandlers {
  readonly onObservation: (observation: NormalizedOrderObservation) => void;
  readonly onConnecting: () => void;
  readonly onConnected: (args: { authorised: boolean; reconnect: boolean }) => void;
  readonly onDisconnected: () => void;
  readonly onSessionLost: (reason: string) => void;
}

/**
 * Build the PRODUCTION Dhan order-feed lifecycle handlers for one consumer.
 *
 * The five callbacks map the dedicated order socket's events onto the consumer's lifecycle, keeping
 * these five things distinct — which is the whole point, because collapsing any two of them is how a
 * false readiness claim gets made:
 *
 *   1. TRANSPORT CONNECTION   `onConnecting` → CONNECTING. A route is being established.
 *   2. LOGIN SUBMISSION       `onConnected`  → `onSocketOpen()` then `onAuthenticated("login_submitted")`.
 *                             Dhan's order-update socket publishes NO authentication acknowledgement,
 *                             so `args.authorised` means "the login frame was written and has not been
 *                             rejected". That is an assumption. It is recorded as such and can never on
 *                             its own reach READY.
 *   3. AUTHENTICATION EVIDENCE Upgraded to `rest_verified` only when a REST call on the same session
 *                             succeeds. For this transport the reconciliation sweep IS that call, so
 *                             authentication is established by the same round trip that repairs the gap.
 *   4. REST RECONCILIATION    `runReconnectReconciliation()` — started on EVERY authorised connection,
 *                             first connect included, because the broker does not promise to replay
 *                             events missed while we were away and a first connect has no baseline at
 *                             all. Its RESULT is checked, not merely awaited.
 *   5. OPERATIONAL READINESS  Reached only when that checked sweep says the account is consistent.
 *
 * Deliberately NOT awaited: a socket callback must not block on a REST round trip. Safety does not
 * depend on the await — it depends on the lifecycle refusing new entry until the sweep has actually
 * succeeded, which is the opposite of optimistic.
 */
export function createDhanOrderStreamHandlers(
  consumer: OrderStreamConsumer,
  clocks?: { readonly nowMono?: () => number; readonly nowWall?: () => number },
): DhanOrderStreamHandlers & {
  readonly nowMono?: () => number;
  readonly nowWall?: () => number;
} {
  return {
    onObservation: (obs) => {
      consumer.ingestStreamObservation(obs);
    },
    onConnecting: () => {
      consumer.onConnecting();
    },
    onConnected: (args) => {
      // Socket open is step 1, never readiness. Drive the machine through open → login-submitted so
      // it can never read READY merely because a route exists.
      consumer.onSocketOpen();
      if (!args.authorised) return;
      consumer.onAuthenticated("login_submitted");
      // THE LINE WHOSE ABSENCE WAS THE DEFECT. Duplicate connection callbacks coalesce onto one
      // sweep, the result is scoped to this connection epoch, and a failure leaves the lifecycle in
      // RECONCILING (entry refused) with a bounded retry armed — fail-closed for permission,
      // fail-open for control flow.
      void consumer.runReconnectReconciliation();
    },
    onDisconnected: () => {
      consumer.onDisconnected();
    },
    onSessionLost: (reason) => {
      consumer.onSessionLost(reason);
    },
    ...(clocks?.nowMono ? { nowMono: clocks.nowMono } : {}),
    ...(clocks?.nowWall ? { nowWall: clocks.nowWall } : {}),
  };
}
