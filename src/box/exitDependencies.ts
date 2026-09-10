/**
 * EXPOSURE-AWARE EXIT DEPENDENCIES — the single, pure definition.
 *
 * THE DEFECT THIS CLOSES. `executionGateway.simulateLeggingExit` used to build one exit request per
 * outstanding role and fire ALL of them concurrently through `Promise.allSettled`. Nothing related
 * the exit BUYs that CLOSE the short legs to the exit SELLs that RELEASE the long hedges.
 * Reproduced on e357b83 (`tests/box/defectAExitHedgeDependencies.test.mjs`): entering a complete
 * LONG_BOX and then exiting it, with both short-closing BUYs returning CANCELLED/0-filled while
 * both hedge-releasing SELLs filled, transmitted 75 of 75 units of BOTH hedges and left TWO NAKED
 * SHORT OPTIONS. The entry path already had a proven-coverage barrier
 * (`hedgeCoverageLedger.ts`, whose header says "SCOPE — ENTRY ONLY"); the exit path had nothing.
 *
 * THE GEOMETRY. A box is two verticals: the two calls and the two puts. Within each vertical one
 * leg is long and the other short, so the long leg IS the hedge for the short leg beside it:
 *
 *   LONG_BOX   k1_ce BUY  hedges k2_ce SELL  |  k2_pe BUY  hedges k1_pe SELL
 *   SHORT_BOX  k2_ce BUY  hedges k1_ce SELL  |  k1_pe BUY  hedges k2_pe SELL
 *
 * THE RULE. Closing a short is a BUY: it can only ever REDUCE unbounded risk, so it goes first.
 * Releasing a hedge is a SELL: it INCREASES risk if its paired short is still open, so it may only
 * ever be transmitted for the quantity that is PROVEN no longer needed as cover:
 *
 *     releasable = hedge_outstanding − short_still_outstanding
 *
 * with `short_still_outstanding` derived ONLY from authoritative broker fill quantity. Acceptance,
 * an order id, an ACK or a terminal status LABEL is not a fill. While a short close can still fill
 * the remaining short quantity is UNKNOWN, and unknown releases NOTHING — the alternative is
 * guessing a quantity while an order can still fill, which is exactly how the hedge got sold.
 *
 * ARBITRARY RESIDUAL GEOMETRY. Recovery exposure is not a box. A long leg whose paired short is
 * already flat has nothing to wait for and is released immediately; a hedge larger than the short
 * beside it releases the excess immediately. Nothing here can require a nonexistent short leg to
 * close first, which would deadlock a long-only residual forever.
 *
 * PURE and total: no clock, no config, no I/O, no broker. Both directions are enumerated by test.
 */

import {
  BOX_ENTRY_SIDES_BY_DIRECTION,
  BOX_LEG_ROLES,
  type BoxDirection,
  type BoxLegRole,
  type OrderSide,
} from "./types.js";

/**
 * The other leg of the same vertical.
 *
 * Total over the four real roles, and exhaustively checked so a future fifth role cannot silently
 * fall through to a wrong partner.
 */
export function verticalPartner(role: BoxLegRole): BoxLegRole {
  switch (role) {
    case "k1_ce": return "k2_ce";
    case "k2_ce": return "k1_ce";
    case "k1_pe": return "k2_pe";
    case "k2_pe": return "k1_pe";
  }
}

/**
 * For a direction, the LONG leg that hedges each SHORT leg.
 *
 * Derived from the entry sides rather than hard-coded, so the two tables can never drift apart.
 */
export function hedgeForShort(direction: BoxDirection): Readonly<Partial<Record<BoxLegRole, BoxLegRole>>> {
  const sides = BOX_ENTRY_SIDES_BY_DIRECTION[direction];
  const out: Partial<Record<BoxLegRole, BoxLegRole>> = {};
  for (const role of BOX_LEG_ROLES) {
    if (sides[role] !== "SELL") continue;
    const partner = verticalPartner(role);
    // A box vertical always pairs one BUY with one SELL. Asserting it keeps the mapping honest
    // instead of silently naming a second short leg as somebody's hedge.
    if (sides[partner] === "BUY") out[role] = partner;
  }
  return out;
}

/** What an exit leg DOES to the account's risk. */
export type ExitLegKind =
  /** An exit BUY that closes short option exposure. Reduces unbounded risk; never gated. */
  | "close_short"
  /** An exit SELL of a long leg whose paired short is still outstanding. Dependent. */
  | "release_hedge"
  /** An exit SELL of a long leg with no outstanding short beside it. Nothing to wait for. */
  | "close_unpaired_long";

/** One exit leg's place in the exposure-aware exit sequence. */
export interface ExitDependencySlot {
  readonly role: BoxLegRole;
  /** The side that CLOSES this role under the position's direction. */
  readonly side: OrderSide;
  readonly kind: ExitLegKind;
  /** Outstanding quantity on this role at plan time. */
  readonly outstanding: number;
  /** 0 = risk-reducing, transmit now. 1 = dependent, transmit only on proven release. */
  readonly wave: 0 | 1;
  /** The short role this hedge must keep covering, or null when nothing depends on it. */
  readonly covers: BoxLegRole | null;
}

export interface ExitDependencyPlan {
  readonly direction: BoxDirection;
  /** Risk-reducing closes and unpaired longs: everything safe to transmit immediately. */
  readonly wave0: readonly ExitDependencySlot[];
  /** Hedge releases, each dependent on proven closure of the short it covers. */
  readonly wave1: readonly ExitDependencySlot[];
  readonly slots: readonly ExitDependencySlot[];
}

/**
 * Plan the exit of arbitrary outstanding exposure.
 *
 * `outstanding` is the position's remaining quantity by role. Roles with no outstanding quantity
 * produce no slot. Order within each wave follows the canonical {@link BOX_LEG_ROLES} sequence, so
 * the plan is deterministic and diffable.
 */
export function planExitDependencies(
  direction: BoxDirection,
  outstanding: Readonly<Partial<Record<BoxLegRole, number>>>,
): ExitDependencyPlan {
  const sides = BOX_ENTRY_SIDES_BY_DIRECTION[direction];
  const qty = (role: BoxLegRole): number => {
    const value = outstanding[role];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  };

  const slots: ExitDependencySlot[] = [];
  for (const role of BOX_LEG_ROLES) {
    const own = qty(role);
    if (own === 0) continue;
    const exitSide: OrderSide = sides[role] === "BUY" ? "SELL" : "BUY";

    if (sides[role] === "SELL") {
      // This role is SHORT. Closing it is a BUY and is unconditionally risk-reducing.
      slots.push({ role, side: exitSide, kind: "close_short", outstanding: own, wave: 0, covers: null });
      continue;
    }

    // This role is LONG. It is a hedge only while a short still stands beside it.
    const partner = verticalPartner(role);
    const partnerIsShort = sides[partner] === "SELL";
    const partnerOutstanding = partnerIsShort ? qty(partner) : 0;
    if (partnerOutstanding > 0) {
      slots.push({ role, side: exitSide, kind: "release_hedge", outstanding: own, wave: 1, covers: partner });
    } else {
      slots.push({ role, side: exitSide, kind: "close_unpaired_long", outstanding: own, wave: 0, covers: null });
    }
  }

  return {
    direction,
    slots,
    wave0: slots.filter((slot) => slot.wave === 0),
    wave1: slots.filter((slot) => slot.wave === 1),
  };
}

/**
 * Authoritative evidence about ONE short-closing attempt, as the exit path observed it.
 *
 * `certain` is the whole safety question. It is true ONLY when the outcome can no longer change:
 * a terminal broker snapshot, or a proven local refusal that never reached the broker. Anything
 * working, unknown, ambiguous or errored is NOT certain, and an uncertain short releases nothing.
 */
export interface ShortCloseEvidence {
  /** Outstanding short quantity BEFORE this attempt. */
  readonly shortOutstanding: number;
  /** Broker-confirmed cumulative filled quantity of the closing BUY. Never a status label. */
  readonly confirmedClosed: number;
  /** True only when the outcome is terminal (or provably never sent). */
  readonly certain: boolean;
}

/**
 * How much of a hedge is PROVEN free to sell.
 *
 * Fails closed on every unreadable input: a non-finite or negative figure releases nothing rather
 * than defaulting to the whole hedge.
 */
export function releasableHedgeQuantity(args: {
  readonly hedgeOutstanding: number;
  readonly short: ShortCloseEvidence;
}): number {
  const hedge = args.hedgeOutstanding;
  const short = args.short;
  if (!Number.isFinite(hedge) || hedge <= 0) return 0;
  if (!Number.isFinite(short.shortOutstanding) || short.shortOutstanding < 0) return 0;

  const closed = short.certain && Number.isFinite(short.confirmedClosed) && short.confirmedClosed > 0
    // A broker cannot close more than was outstanding; clamp rather than manufacture free hedge.
    ? Math.min(short.confirmedClosed, short.shortOutstanding)
    : 0;
  const shortRemaining = short.shortOutstanding - closed;
  return Math.max(0, Math.min(hedge, hedge - shortRemaining));
}

/**
 * The dependency contract restated as an independent oracle for the tests.
 *
 * True when a transmitted exit sequence never released hedge quantity that was still required as
 * cover. Deliberately re-derives the property from the (side, role, quantity) triples instead of
 * reusing {@link releasableHedgeQuantity}, so a bug in the planner cannot also certify itself.
 */
export function isExposureSafeExitSequence(
  direction: BoxDirection,
  outstanding: Readonly<Partial<Record<BoxLegRole, number>>>,
  transmitted: readonly { readonly role: BoxLegRole; readonly quantity: number; readonly filled: number }[],
): boolean {
  const sides = BOX_ENTRY_SIDES_BY_DIRECTION[direction];
  const remaining = new Map<BoxLegRole, number>();
  for (const role of BOX_LEG_ROLES) remaining.set(role, Math.max(0, outstanding[role] ?? 0));

  for (const leg of transmitted) {
    if (sides[leg.role] === "SELL") {
      // A short close: credit only what actually filled.
      remaining.set(leg.role, Math.max(0, (remaining.get(leg.role) ?? 0) - leg.filled));
      continue;
    }
    const partner = verticalPartner(leg.role);
    const shortStanding = sides[partner] === "SELL" ? (remaining.get(partner) ?? 0) : 0;
    const hedgeStanding = remaining.get(leg.role) ?? 0;
    if (leg.quantity > Math.max(0, hedgeStanding - shortStanding)) return false;
    remaining.set(leg.role, Math.max(0, hedgeStanding - leg.filled));
  }
  return true;
}
