/**
 * STAGE-AWARE FUNDING THROUGH THE PRODUCTION PROVIDER PATH.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE DEFECTS
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 1. THE ENCUMBRANCE WAS READ AND THROWN AWAY. engine.ts's `funds` provider called
 *    `adapter.margins()` — which returns `{ available, utilised }` — and returned only
 *    `{ availableRupees, observedAt }`. `utilised`, the ₹ already blocked by other open orders and
 *    positions, was discarded. Meanwhile the stage model was handed `encumbranceRupees: null` from
 *    the BASKET-MARGIN provider, whose comment correctly said "not observable from the basket
 *    endpoint" — true of that endpoint, but the funds endpoint reports it and the other provider
 *    already had the answer in hand.
 *
 *    Consequence: strict stage funding could NEVER establish a requirement, so it had to be left
 *    disabled — and with it disabled, admission fell back to the broker `planned_margin`, which for
 *    a box is the FINAL (completed-basket, spread-benefit) figure. That is precisely the number the
 *    stage model exists to stop being used as proof that the account can fund the SEQUENCE which
 *    creates the box. In Zerodha's own basket example the two differ by ~2.8x.
 *
 * 2. A CONTRADICTORY FLAG COMBINATION THAT LOOKED STRICTER THAN IT WAS.
 *    BOX_LIVE_REQUIRE_STAGE_FUNDING=true with BOX_LIVE_REQUIRE_FUNDS_COVER=false computed a precise
 *    stage requirement, verified the sequence was hedge-first — and never compared the requirement
 *    against the account's funds, because that comparison lives entirely inside the funds-cover
 *    block. A configuration that reads as the strictest available while omitting the only check that
 *    involves money is worse than one that reads as lax, because it is trusted.
 *
 * 3. THE MEANING OF "AVAILABLE" WAS ASSUMED. Whether a broker's available figure is already net of
 *    the encumbrance decides the arithmetic completely, and the two possible errors are not
 *    symmetric: understating refuses affordable entries (safe), overstating admits an entry the
 *    account cannot fund and leaves partially-executed exposure to recover from.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFundingPicture,
  evaluateEconomicAdmission,
  buildEconomicPicture,
} from "../../dist/box/boxCapital.js";
import {
  usableFundsRupees,
  BROKER_FUNDS_SEMANTICS,
  knownBrokerFundsSemantics,
} from "../../dist/box/fundsSemantics.js";

/* ─────────────────────────── fixtures ─────────────────────────── */

const USABLE = { status: "usable", note: "broker-confirmed, fresh" };

/** Four bounded LIMIT requests in the real hedge-first transport order for a LONG_BOX. */
function requests() {
  const mk = (role, side, price) => ({
    client_order_id: `BOX:T1:ENTRY:${role}:a1`,
    role,
    side,
    quantity: 75,
    tradingsymbol: `NIFTY26OCT${role}`,
    exchange: "NFO",
    token: 1000 + role.length,
    pricing: { order_type: "LIMIT", limit_price: price, reference_price: price, tick_size: 0.05, max_chase_ticks: 3 },
  });
  return [
    mk("k1_ce", "BUY", 200),
    mk("k1_pe", "BUY", 20),
    mk("k2_ce", "SELL", 30),
    mk("k2_pe", "SELL", 150),
  ];
}

const TRANSPORT_ORDER = [
  { role: "k1_ce", side: "BUY", rank: 0 },
  { role: "k1_pe", side: "BUY", rank: 1 },
  { role: "k2_ce", side: "SELL", rank: 2 },
  { role: "k2_pe", side: "SELL", rank: 3 },
];

function funding({ initial, final, encumbrance, reserve = 0 }) {
  return buildFundingPicture({
    requests: requests(),
    now: 1_000,
    transportOrder: TRANSPORT_ORDER,
    initialMarginRupees: initial,
    finalMarginRupees: final,
    encumbranceRupees: encumbrance,
    recoveryReserveRupees: reserve,
    plannedMarginAged: USABLE,
    planFingerprint: "fp-1",
    estimatedChargesRupees: 120,
  });
}

/** The full picture + admission, as executionGateway assembles it. */
function admit({
  availableRupees,
  utilisedRupees,
  broker = "zerodha",
  initial = 96_505,
  final = 34_787,
  requireFundsCover = false,
  requireStageFunding = true,
  requireMarginEvidence = true,
  reserve = 0,
}) {
  // The SAME derivation executionGateway performs before building the picture.
  const usable = usableFundsRupees({ broker, availableRupees, utilisedRupees });
  const picture = buildEconomicPicture({
    requests: requests(),
    now: 1_000,
    availableFundsRupees: usable.value_rupees,
    availableFundsBasis: usable.basis,
    availableFundsAged: USABLE,
    plannedMarginRupees: final,
    plannedMarginAged: USABLE,
    planFingerprint: "fp-1",
    estimatedChargesRupees: 120,
    expectedLegCount: 4,
    ...(initial != null || final != null
      ? {
          funding: {
            transportOrder: TRANSPORT_ORDER,
            initialMarginRupees: initial,
            finalMarginRupees: final,
            encumbranceRupees: utilisedRupees,
            recoveryReserveRupees: reserve,
          },
        }
      : {}),
  });
  const report = evaluateEconomicAdmission({
    picture,
    grossCapRupees: 0,
    requireFundsCover,
    requireMarginEvidence,
    requireStageFunding,
    evaluatedAt: 1_000,
    planFingerprint: "fp-1",
  });
  return { usable, picture, report };
}

/* ═══════════════ 1. the encumbrance is now establishable ═══════════════ */

test("REPRODUCTION: with encumbrance NULL the stage model cannot establish a requirement", () => {
  const f = funding({ initial: 96_505, final: 34_787, encumbrance: null });
  assert.equal(
    f.binding_requirement.usable,
    false,
    "a null encumbrance leaves the binding stage requirement unestablishable — which is why strict " +
      "stage funding had to be left disabled",
  );
  const { report } = admit({ availableRupees: 500_000, utilisedRupees: null });
  assert.equal(report.allowed, false);
  assert.ok(report.reasons.includes("funding_stage_unknown"), "and stage funding refuses");
});

test("with the encumbrance supplied from the funds endpoint the stage requirement IS establishable", () => {
  const f = funding({ initial: 96_505, final: 34_787, encumbrance: 0 });
  assert.equal(f.binding_requirement.usable, true, "a trustworthy encumbrance completes the model");
  assert.ok(f.binding_requirement.value_rupees > 0);
  assert.deepEqual(f.unknown_stages, [], "no stage is unknown");
});

test("a trustworthy ZERO encumbrance is handled DISTINCTLY from a missing one", () => {
  const zero = funding({ initial: 96_505, final: 34_787, encumbrance: 0 });
  const missing = funding({ initial: 96_505, final: 34_787, encumbrance: null });

  assert.equal(zero.binding_requirement.usable, true, "a reported ₹0 utilisation is a real figure");
  assert.equal(missing.binding_requirement.usable, false, "an ABSENT one is not zero");
  assert.notEqual(
    zero.binding_requirement.value_rupees,
    missing.binding_requirement.value_rupees,
    "the two must not collapse to the same answer",
  );
});

/* ═══════════════ 2. intermediate stage unaffordable while the FINAL margin is affordable ═══════════════ */

test("final margin affordable but the INTERMEDIATE stage requirement unaffordable: REFUSE", () => {
  // Zerodha's own basket example: initial ₹96,505 vs final ₹34,787 for the same four legs. An account
  // holding ₹50,000 can afford the COMPLETED box but cannot fund the sequence that creates it.
  const { report, picture } = admit({
    availableRupees: 50_000,
    utilisedRupees: 0,
    initial: 96_505,
    final: 34_787,
    requireStageFunding: true,
    requireFundsCover: false, // deliberately off — the implication must still enforce the check
  });

  assert.ok(
    picture.funding.binding_requirement.value_rupees > 50_000,
    "the binding stage requirement exceeds the balance",
  );
  assert.ok(
    picture.planned_margin.value_rupees < 50_000,
    "while the completed-basket margin is comfortably affordable — the trap this closes",
  );
  assert.equal(report.allowed, false, "the entry must be refused");
  assert.ok(
    report.reasons.includes("insufficient_available_funds"),
    "and refused for INSUFFICIENT FUNDS against the stage requirement, not merely 'unknown'",
  );
  assert.match(report.detail, /binding hedge-first stage requirement/);
});

test("sufficient verified stage funds: PERMITTED when every other gate passes", () => {
  const { report } = admit({
    availableRupees: 500_000,
    utilisedRupees: 0,
    initial: 96_505,
    final: 34_787,
    requireStageFunding: true,
    requireFundsCover: true,
  });
  assert.deepEqual(report.reasons, [], "no refusal reason");
  assert.equal(report.allowed, true);
});

/* ═══════════════ 3. the contradictory flag combination is eliminated ═══════════════ */

test("stage funding IMPLIES the funds-cover check, so it cannot appear strict while skipping money", () => {
  // THE OLD HOLE: requireStageFunding=true + requireFundsCover=false computed a precise stage
  // requirement, checked the sequence was hedge-first, and never compared it to the balance.
  const { report } = admit({
    availableRupees: 1_000, // nowhere near enough
    utilisedRupees: 0,
    requireStageFunding: true,
    requireFundsCover: false,
  });
  assert.equal(report.allowed, false, "₹1,000 cannot fund a ₹96,505 stage requirement");
  assert.ok(report.reasons.includes("insufficient_available_funds"));
  assert.equal(
    report.controls.funds_check_enabled,
    true,
    "and the published control surface reports the EFFECTIVE value, not the raw flag",
  );
});

test("with BOTH controls off, nothing is claimed about funding", () => {
  const { report } = admit({
    availableRupees: 1_000,
    utilisedRupees: 0,
    requireStageFunding: false,
    requireFundsCover: false,
    requireMarginEvidence: false,
  });
  assert.equal(report.controls.funds_check_enabled, false, "no implication is invented when nothing asked");
  assert.equal(report.allowed, true, "an unsupervised profile is unchanged by this fix");
});

/* ═══════════════ 4. funds semantics: no double subtraction, no silent guess ═══════════════ */

test("Zerodha funds are documented as ALREADY NET, so the encumbrance is not subtracted twice", () => {
  const v = usableFundsRupees({ broker: "zerodha", availableRupees: 200_000, utilisedRupees: 80_000 });
  assert.equal(v.value_rupees, 200_000, "no double subtraction");
  assert.equal(v.semanticsUnverified, false);
  assert.match(v.basis, /NOT subtracted again/);
  assert.equal(BROKER_FUNDS_SEMANTICS.zerodha.availableIsNetOfEncumbrance, "net_of_encumbrance");
});

test("Dhan funds semantics are NOT VERIFIED, so the CONSERVATIVE (understating) reading is used", () => {
  const v = usableFundsRupees({ broker: "dhan", availableRupees: 200_000, utilisedRupees: 80_000 });
  assert.equal(v.value_rupees, 120_000, "utilised is subtracted: understating is the safe direction");
  assert.equal(v.semanticsUnverified, true);
  assert.match(v.basis, /NOT VERIFIED/);
  assert.match(v.basis, /UNDERSTATES spendable funds/, "and the direction of the error is stated");
  assert.equal(BROKER_FUNDS_SEMANTICS.dhan.availableIsNetOfEncumbrance, "unverified");
});

test("an UNRECOGNISED broker yields NO figure rather than another broker's semantics", () => {
  const v = usableFundsRupees({ broker: "someOtherBroker", availableRupees: 200_000, utilisedRupees: 0 });
  assert.equal(v.value_rupees, null);
  assert.match(v.basis, /not declared for broker/);
  assert.equal(knownBrokerFundsSemantics("someOtherBroker"), null);
  assert.equal(knownBrokerFundsSemantics(null), null);
});

test("a MISSING encumbrance under unverified semantics establishes nothing", () => {
  const v = usableFundsRupees({ broker: "dhan", availableRupees: 200_000, utilisedRupees: null });
  assert.equal(v.value_rupees, null, "missing is not zero");
  assert.equal(v.encumbranceMissing, true);
});

test("a MISSING available figure establishes nothing, whatever the encumbrance says", () => {
  for (const broker of ["zerodha", "dhan"]) {
    const v = usableFundsRupees({ broker, availableRupees: null, utilisedRupees: 0 });
    assert.equal(v.value_rupees, null, `${broker}: no available figure ⇒ no spendable funds`);
  }
});

test("a trustworthy ZERO available balance is a real figure, not a missing one", () => {
  const v = usableFundsRupees({ broker: "zerodha", availableRupees: 0, utilisedRupees: 0 });
  assert.equal(v.value_rupees, 0, "₹0 is a genuine balance; Number.isFinite(0) is true");
  const { report } = admit({ availableRupees: 0, utilisedRupees: 0, requireFundsCover: true });
  assert.equal(report.allowed, false, "and ₹0 funds nothing");
  assert.ok(report.reasons.includes("insufficient_available_funds"));
});

/* ═══════════════ 5. numeric-zero initial/final must stay UNAVAILABLE, not become free ═══════════════ */

test("initial/final margins represented numerically as ZERO do not make the box free", () => {
  // A provider that maps a missing field to 0 rather than null would otherwise produce a ₹0
  // requirement and admit anything. The stage requirement must still include charges and reserve.
  const f = funding({ initial: 0, final: 0, encumbrance: 0, reserve: 5_000 });
  const need = f.binding_requirement.value_rupees;
  assert.ok(
    need === null || need >= 5_000,
    `a zero margin must not yield a zero requirement (got ${need}); charges and the recovery reserve still apply`,
  );
});

test("the recovery reserve raises the requirement and is documented in the figure", () => {
  const without = funding({ initial: 96_505, final: 34_787, encumbrance: 0, reserve: 0 });
  const withReserve = funding({ initial: 96_505, final: 34_787, encumbrance: 0, reserve: 25_000 });
  assert.ok(
    withReserve.binding_requirement.value_rupees > without.binding_requirement.value_rupees,
    "the reserve is genuinely held back rather than merely reported",
  );
});

test("a non-zero encumbrance raises the requirement", () => {
  const idle = funding({ initial: 96_505, final: 34_787, encumbrance: 0 });
  const busy = funding({ initial: 96_505, final: 34_787, encumbrance: 40_000 });
  assert.ok(
    busy.binding_requirement.value_rupees > idle.binding_requirement.value_rupees,
    "funds already blocked by other activity are not available to this entry",
  );
});

/* ═══════════════ 6. missing margin evidence still refuses when needed ═══════════════ */

test("no initial/final margin at all: no funding model, and stage funding refuses", () => {
  const { report, picture } = admit({
    availableRupees: 500_000,
    utilisedRupees: 0,
    initial: null,
    final: null,
    requireStageFunding: true,
    requireMarginEvidence: false,
  });
  assert.equal(picture.funding, null, "no stage model can be built without broker initial/final");
  assert.equal(report.allowed, false);
  assert.ok(report.reasons.includes("funding_stage_unknown"));
  assert.match(report.detail, /refused rather than admitted on the completed-basket figure/);
});

/* ═══════════════ 7. the refusal explains its own arithmetic ═══════════════ */

test("the available-funds figure carries HOW it was derived, so a refusal is diagnosable", () => {
  const { picture } = admit({ broker: "dhan", availableRupees: 200_000, utilisedRupees: 80_000 });
  assert.match(
    picture.available_funds.note,
    /NOT VERIFIED/,
    "an operator reading the refusal must see that the conservative reading was applied",
  );
  const zerodha = admit({ broker: "zerodha", availableRupees: 200_000, utilisedRupees: 80_000 });
  assert.match(zerodha.picture.available_funds.note, /NOT subtracted again/);
});

/* ═══════════════ 8. every declared broker has a complete, citable record ═══════════════ */

test("every broker's funds semantics carry a source and a verification date", () => {
  for (const [broker, s] of Object.entries(BROKER_FUNDS_SEMANTICS)) {
    assert.ok(s.source.startsWith("https://"), `${broker}: a citable source is required`);
    assert.match(s.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, `${broker}: a verification date is required`);
    assert.ok(s.availableField.length > 0, `${broker}: the mapped field must be named`);
    assert.ok(s.utilisedField.length > 0, `${broker}: the mapped field must be named`);
    assert.ok(s.note.length > 40, `${broker}: the semantics must be explained, not asserted`);
    assert.ok(
      ["net_of_encumbrance", "gross_of_encumbrance", "unverified"].includes(s.availableIsNetOfEncumbrance),
      `${broker}: the semantics value must be one of the declared kinds`,
    );
  }
});
