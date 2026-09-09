/**
 * ZERODHA ORDER-UPDATE TRANSPORT — parse the postbacks that arrived on the ticker socket
 * and were being THROWN AWAY.
 *
 * THE DEFECT THIS FIXES
 * `ticker.ts` opens `wss://ws.kite.trade` for market data, and its `onmessage` did:
 *
 *     if (typeof data === "string") return;   // "postbacks / order updates — ignore"
 *
 * Per the current Kite Connect v3 documentation (verified 2026-09-09,
 * https://kite.trade/docs/connect/v3/websocket/#postbacks-and-non-binary-updates), that same
 * socket ALSO streams order updates as TEXT frames shaped:
 *
 *     { "type": "order",   "data": { <full postback payload> } }
 *     { "type": "error",   "data": "…" }
 *     { "type": "message", "data": "…" }
 *
 * The `data` of an `order` frame is the Postback payload
 * (https://kite.trade/docs/connect/v3/postbacks/, verified 2026-09-09): `order_id`, `status`,
 * `filled_quantity` (CUMULATIVE), `average_price`, `tag`, `user_id`, `tradingsymbol`,
 * `exchange_timestamp`, etc. So the fast path was already on the wire and merely discarded —
 * this module turns those frames into normalized observations for the unified projection.
 *
 * WHY A DEDICATED SOCKET IS NOT OPENED
 * Zerodha delivers order updates on the EXISTING quote socket; there is no separate order
 * socket. So this module is a pure PARSER, not a connection manager: `ticker.ts` forwards the
 * text frame here. Its own health is still reported separately from market-data health,
 * because the socket being open (market data flowing) does NOT prove order updates are being
 * delivered — that is a Kite-account/subscription property we cannot infer from ticks.
 *
 * PURITY. No sockets, no clock. `parseKiteOrderFrame` is a pure function; the caller stamps
 * the observation with times from the injected execution clock.
 */

import type { NormalizedOrderObservation } from "../../box/orderUpdateProjection.js";

/** The three text-frame kinds Kite sends over the quote socket. */
export type KiteTextFrameType = "order" | "error" | "message";

export interface KiteParsedTextFrame {
  type: KiteTextFrameType | "unknown";
  /** Present only for `type === "order"`: a normalized observation ready for the projection. */
  observation: NormalizedOrderObservation | null;
  /** Present for `error`/`message`: the human-readable string Kite sent. */
  text: string | null;
}

/** The subset of the Kite postback payload this projection needs. Everything else is ignored. */
interface KiteOrderPostback {
  order_id?: unknown;
  status?: unknown;
  filled_quantity?: unknown;
  average_price?: unknown;
  tag?: unknown;
  user_id?: unknown;
  exchange_update_timestamp?: unknown;
  exchange_timestamp?: unknown;
  order_timestamp?: unknown;
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
 * Parse one Kite WebSocket TEXT frame.
 *
 * Returns `type: "unknown"` (never throws) for anything unrecognised, because a malformed or
 * newly-added frame kind must degrade to "ignored", never crash the market-data socket that
 * also carries the ticks the whole strategy depends on.
 *
 * The `observation` it builds is deliberately WITHOUT times — the caller stamps
 * observedAtMono/observedAtWall from the injected clock so replay is deterministic.
 */
export function parseKiteOrderFrame(raw: string): KiteParsedTextFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: "unknown", observation: null, text: null };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { type: "unknown", observation: null, text: null };
  }
  const frame = parsed as { type?: unknown; data?: unknown };
  const type = frame.type;

  if (type === "error" || type === "message") {
    return { type, observation: null, text: typeof frame.data === "string" ? frame.data : null };
  }
  if (type !== "order" || typeof frame.data !== "object" || frame.data === null) {
    return { type: "unknown", observation: null, text: null };
  }

  const data = frame.data as KiteOrderPostback;
  const orderId = str(data.order_id);
  const tag = str(data.tag);
  // A postback with neither a tag NOR an order id cannot be attributed to any of our orders.
  // Emit it as an observation anyway (ownerTag empty) so the projection records it as
  // `unowned` rather than this module silently dropping it — the projection is the single
  // place ownership is decided.
  const filled = num(data.filled_quantity);
  const avg = num(data.average_price);
  const status = str(data.status);
  const account = str(data.user_id);
  // Kite has no per-postback sequence number. The exchange_update_timestamp is the closest
  // stable per-event identity; combined with the cumulative-monotonic ledger it is enough to
  // deduplicate redelivered postbacks. It is NOT trusted for ordering (the ledger's cumulative
  // rule handles that); it only distinguishes two genuinely distinct updates.
  const eventStamp =
    str(data.exchange_update_timestamp) ?? str(data.exchange_timestamp) ?? str(data.order_timestamp);
  const eventId = orderId && eventStamp ? `${orderId}:${eventStamp}:${filled ?? "?"}` : null;

  const observation: NormalizedOrderObservation = {
    ownerTag: tag ?? "",
    brokerOrderId: orderId,
    account,
    // A postback without filled_quantity is a status-only update (e.g. a bare ACK). Zero is the
    // honest cumulative in that case; the monotonic ledger treats it as carrying no new
    // quantity, so it can never rewind a prior fill.
    cumulativeQty: filled ?? 0,
    averagePrice: avg,
    rawStatus: status,
    eventId,
    source: "order_update",
  };
  return { type: "order", observation, text: null };
}
