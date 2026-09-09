# HANDOFF — hedge

No change was made to any file owned by another agent. This records one
OPTIONAL, non-blocking improvement that would strengthen the coverage
attribution, and which lives in a file I do not own.

## 1. A first-class broker/account identifier on `BrokerAdapter` (OPTIONAL)

Owner: `src/box/brokerAdapter.ts` (+ `kiteBrokerAdapter.ts`, `dhanBrokerAdapter.ts`).

WHAT. The hedge coverage ledger (`src/box/hedgeCoverageLedger.ts`) attributes
proven hedge fills to a `broker_account` axis, so that a fill on one account can
never be counted as coverage for a dependent SELL on another account. The
`BrokerAdapter` interface currently exposes only `readonly mode`
(`"paper" | "live"`), so the manager derives the account key as
`broker:${adapter.mode}` (see `BoxOrderManager.brokerAccountKey`).

WHY THIS IS SUFFICIENT TODAY. Within one `BoxOrderManager` a hedge and its
dependent SELL are always submitted through the SAME adapter instance, so the
derived key is identical for the requirement and the evidence — which is exactly
the property the account-mismatch check needs, and it is enforced. The
attribution axis is therefore correct for the current single-account-per-manager
deployment.

WHAT WOULD BE STRONGER. If a future deployment ran two live accounts through one
shared manager/gateway layer, `mode` alone could not distinguish them. A stable
per-account identifier — e.g. `readonly accountId: string` on `BrokerAdapter`,
populated by each live adapter from its authenticated broker client id — would
let `brokerAccountKey()` return a genuinely per-account key and make the
account-mismatch check bite across accounts.

HOW MY CODE AVOIDS NEEDING THE CHANGE. `hedgeCoverageLedger.ts` already models
`broker_account` as a first-class attribution axis and checks it; only the KEY
DERIVATION in `orderManager.brokerAccountKey()` would need to read the new field.
Nothing in the guard/ledger contract needs to change. The
`BeforeBrokerPost = () => void` throwing-refusal contract is untouched.

STATUS: not required for this defect fix; left as a note for whoever owns the
adapter files. No action needed unless/until a multi-account-per-manager
deployment is planned.
