/**
 * BROKER EXECUTION EVIDENCE — one place that decides what a broker actually PROVED.
 *
 * THE DEFECT THIS CLOSES. Every Dhan observation path funnelled through `project()`, which read
 * the cumulative quantity as `numberOr(remote.filledQty, 0)` and the price as
 * `numberOr(remote.averageTradedPrice, 0)`. Both collapse a MISSING field to a NUMBER:
 *
 *   • `TRADED` with no `filledQty` became state COMPLETE with `filled_quantity: 0` — a fully
 *     accounted terminal execution invented from a status label and a hardcoded zero.
 *   • `TRADED` with a real quantity but no `averageTradedPrice` produced a synthesized fill
 *     priced at ZERO, which is fabricated P&L rather than absent data.
 *   • `CANCELLED` with no `filledQty` was accepted as a CONFIRMED zero, so silence about
 *     quantity became proof that nothing executed.
 *
 * The placement-response path had already been hardened (`hasAuthoritativeQuantity`), but REST
 * polling, correlation lookup, `listOrders`, the orphan projection, restart adoption and — once
 * order-update streams are consumed — every websocket update, all shared the unguarded reader.
 *
 * THE DISTINCTION THIS MODULE EXISTS TO PRESERVE:
 *
 *     ABSENT  ≠  EXPLICITLY CONFIRMED ZERO
 *
 * An absent cumulative quantity is not knowledge. An explicit `0` is. Only the second one can
 * terminalise an order as "nothing executed".
 *
 * WHAT CONFIRMED QUANTITY BUYS, AND WHAT IT DOES NOT. A confirmed quantity establishes EXPOSURE,
 * even while price enrichment is still pending: exposure that exists must be reducible, so a
 * missing price must never erase it or block a protective reduction. But a missing price must also
 * never be rendered as a price. So the quantity is accepted and the price stays `null`, the order
 * is marked as accounting-incomplete, and no priced fill is synthesized.
 *
 * MONOTONICITY. A cumulative quantity already observed can only stay the same or grow. Overlapping
 * REST reads and out-of-order stream events are normal; a fleeting lower figure must not rewrite
 * exposure downward.
 *
 * PURE and total: no clock, no config, no I/O, no broker SDK. Broker-neutral by construction — the
 * two adapters differ only in which raw field names they hand to the readers.
 */

import type { BrokerOrder, BrokerOrderState } from "./brokerAdapter.js";

/**
 * A raw broker field, read WITHOUT collapsing absence into a number.
 *
 * `present: false` means the broker did not tell us. `present: true, value: 0` means the broker
 * told us zero. Those are different facts and the whole module exists to keep them apart.
 */
export interface ObservedNumber {
  readonly value: number | null;
  readonly present: boolean;
}

const ABSENT: ObservedNumber = { value: null, present: false };

/**
 * Read a cumulative filled quantity.
 *
 * `undefined`, `null`, `""`, a non-numeric string, a non-finite number, a negative number and a
 * non-integer are all ABSENT: none of them is a quantity a broker can have filled. `0` and `"0"`
 * are PRESENT — that is the confirmed zero the old code could not distinguish.
 */
export function readCumulativeQuantity(raw: { readonly filledQty?: unknown }): ObservedNumber {
  return readNonNegativeInteger(raw.filledQty);
}

/** The same reader, for adapters whose field is named differently. */
export function readNonNegativeInteger(candidate: unknown): ObservedNumber {
  if (candidate === undefined || candidate === null || candidate === "") return ABSENT;
  if (typeof candidate === "boolean") return ABSENT;
  const n = Number(candidate);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return ABSENT;
  return { value: n, present: true };
}

/**
 * Read a traded/average price.
 *
 * ZERO IS NOT A PRICE. A listed option cannot trade at zero, so brokers use `0` (and `null`, and
 * absence) interchangeably as "not published yet". Treating that `0` as a price is precisely the
 * fabricated-P&L failure, so every unusable form maps to ABSENT.
 */
export function readTradedPrice(raw: { readonly averageTradedPrice?: unknown }): ObservedNumber {
  return readPositivePrice(raw.averageTradedPrice);
}

/** The same reader, for adapters whose field is named differently. */
export function readPositivePrice(candidate: unknown): ObservedNumber {
  if (candidate === undefined || candidate === null || candidate === "") return ABSENT;
  if (typeof candidate === "boolean") return ABSENT;
  const n = Number(candidate);
  if (!Number.isFinite(n) || n <= 0) return ABSENT;
  return { value: n, present: true };
}

/** Which fields a broker snapshot actually carried. Recorded so a gap has a nameable reason. */
export interface ExecutionEvidenceQuality {
  readonly quantity: "confirmed" | "missing";
  /** `not_applicable` when a confirmed ZERO fill means there is no price to report. */
  readonly price: "confirmed" | "missing" | "not_applicable";
  /**
   * Whether this snapshot can close the books.
   *
   * `complete`      — quantity and (where relevant) price are both confirmed.
   * `pending_price` — exposure is proven; the price is not, so P&L/charges must not be asserted.
   * `unproven`      — the snapshot cannot support the state it claimed at all.
   *
   * Recorded rather than re-derived, because the qty/price pair alone cannot distinguish
   * "confirmed zero fill" from "no quantity reported and therefore nothing known".
   */
  readonly accounting: "complete" | "pending_price" | "unproven";
}

/** The verdict on one broker snapshot. */
export interface ExecutionEvidenceVerdict {
  /**
   * False when the snapshot cannot support the state it claims. The caller must then keep the
   * order UNCERTAIN (RECONCILIATION_REQUIRED) rather than freeze accounting on it.
   */
  readonly sufficient: boolean;
  /** The cumulative quantity to record. Never below `priorFilled`, never fabricated. */
  readonly filledQuantity: number;
  /** The average price, or null when the broker did not publish a usable one. */
  readonly averagePrice: number | null;
  /**
   * False when exposure is real but its price is still unknown. Exposure remains reducible;
   * P&L, charges and "the box is fully accounted for" must not be asserted.
   */
  readonly accountingComplete: boolean;
  readonly quality: ExecutionEvidenceQuality;
  /** Human-readable reason, for the intent audit and the operator surface. */
  readonly detail: string | null;
}

/**
 * States whose accounting is FROZEN by the snapshot that reports them.
 *
 * These are the states after which nothing more will be read, so they are exactly the states that
 * must not be reached on absent evidence. A working state is not in this set: an order that is
 * still open will be polled again, so "no fill reported yet" is an ordinary observation and reads
 * as zero filled without inventing anything terminal.
 */
function freezesAccounting(state: BrokerOrderState): boolean {
  return state === "COMPLETE" || state === "CANCELLED" || state === "REJECTED" ||
    state === "PARTIALLY_FILLED";
}

/**
 * Decide what a broker snapshot proves.
 *
 * `claimedState` is what the broker's status label maps to BEFORE validation; the caller replaces
 * it with an uncertain state when this returns `sufficient: false`.
 */
export function evaluateExecutionEvidence(args: {
  readonly statusLabel: string;
  readonly claimedState: BrokerOrderState;
  readonly requestedQuantity: number;
  /** Highest cumulative quantity already observed for this order. */
  readonly priorFilled: number;
  readonly quantity: ObservedNumber;
  readonly price: ObservedNumber;
}): ExecutionEvidenceVerdict {
  const prior = Number.isFinite(args.priorFilled) && args.priorFilled > 0 ? args.priorFilled : 0;

  if (!args.quantity.present) {
    if (freezesAccounting(args.claimedState)) {
      // THE CORE REFUSAL. A terminal-looking label with no cumulative quantity is not an
      // execution record. Carry forward what was already proven — never a fabricated zero.
      return {
        sufficient: false,
        filledQuantity: prior,
        averagePrice: args.price.value,
        accountingComplete: false,
        quality: {
          quantity: "missing",
          price: args.price.present ? "confirmed" : "missing",
          accounting: "unproven",
        },
        detail:
          `broker reported '${args.statusLabel}' with no cumulative filled quantity; ` +
          "the execution is unproven and must be reconciled before it is accounted for",
      };
    }
    // A WORKING order with no fill field: ordinary, and not an accounting decision.
    return {
      sufficient: true,
      filledQuantity: prior,
      averagePrice: args.price.value,
      accountingComplete: true,
      quality: {
        quantity: "missing",
        price: prior > 0 ? (args.price.present ? "confirmed" : "missing") : "not_applicable",
        accounting: prior > 0 && !args.price.present ? "pending_price" : "complete",
      },
      detail: null,
    };
  }

  // Monotonic: a later lower cumulative quantity is discarded, never applied.
  const observed = args.quantity.value ?? 0;
  const filled = Math.max(prior, observed);
  const regressed = observed < prior;

  if (filled === 0) {
    // An EXPLICITLY confirmed zero. Authoritative, and there is no price to want.
    return {
      sufficient: true,
      filledQuantity: 0,
      averagePrice: null,
      accountingComplete: true,
      quality: { quantity: "confirmed", price: "not_applicable", accounting: "complete" },
      detail: regressed ? "a later read reported a lower cumulative quantity; the higher observation stands" : null,
    };
  }

  const priced = args.price.present;
  return {
    sufficient: true,
    filledQuantity: filled,
    averagePrice: args.price.value,
    // Exposure is established either way; only the ACCOUNTING waits for the price.
    accountingComplete: priced,
    quality: {
      quantity: "confirmed",
      price: priced ? "confirmed" : "missing",
      accounting: priced ? "complete" : "pending_price",
    },
    detail: priced
      ? (regressed ? "a later read reported a lower cumulative quantity; the higher observation stands" : null)
      : `broker confirmed ${filled} filled but published no average price; exposure stands, ` +
        "P&L and charges must not be asserted until the price is reconciled",
  };
}

/**
 * Whether an order's execution accounting can be treated as final.
 *
 * An UNCERTAIN STATE is never final, whatever the fields say: UNKNOWN and RECONCILIATION_REQUIRED
 * exist precisely to mean "the broker may own something we cannot read", and adapters reach them
 * through quarantine paths that construct an order rather than project one, so they carry no
 * evidence marker to inspect.
 *
 * Otherwise this prefers the adapter's RECORDED verdict, because the quantity/price pair alone
 * cannot tell a confirmed zero fill apart from a snapshot that reported no quantity at all. It
 * falls back to the derived rule for paper and locally-constructed orders, which carry no marker
 * and have nothing to disclaim.
 */
export function executionAccountingComplete(order: Pick<
  BrokerOrder,
  "filled_quantity" | "average_price" | "state"
> & { readonly execution_evidence?: ExecutionEvidenceQuality }): boolean {
  if (order.state === "UNKNOWN" || order.state === "RECONCILIATION_REQUIRED") return false;
  const recorded = order.execution_evidence?.accounting;
  if (recorded !== undefined) return recorded === "complete";
  if (order.filled_quantity > 0) return order.average_price !== null && order.average_price > 0;
  return true;
}
