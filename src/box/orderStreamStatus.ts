/**
 * ORDER-UPDATE STREAM STATUS — the operator-facing answer to one question:
 * "is the fast fill path actually running, or am I relying on REST polling?"
 *
 * WHY THIS EXISTS SEPARATELY FROM MARKET-DATA HEALTH.
 *
 * A working market-data socket proves ticks are arriving. It proves NOTHING about whether
 * order updates are arriving, because on Zerodha they share one socket but different frame
 * types (binary ticks vs text postbacks), and on Dhan they are two entirely different
 * WebSockets. A dashboard that shows one green light for "socket OK" therefore invites
 * exactly the wrong inference: that fills will be observed promptly. This module keeps the
 * two signals structurally apart and makes the order-update answer explicit.
 *
 * THREE DISTINCT SITUATIONS, never collapsed into one:
 *
 *   not_built    — no order-stream implementation for this broker.
 *   not_wired    — the implementation EXISTS and is tested, but no running component is
 *                  consuming it, so it cannot deliver a fill however healthy the socket is.
 *                  This is a REAL operational state and it must not render as "disabled by
 *                  choice", because the operator did not choose it.
 *   gated_off    — implemented AND wired, but the operator has not armed the env gate.
 *   armed        — gate on; the projection's own health then decides LIVE/DOWN/etc.
 *
 * `fills_observed_by` is the field that actually matters to a human: it names the mechanism
 * currently responsible for seeing a fill. When that is `rest_polling_only`, latency to
 * fill observation is bounded by the polling cadence and the pacing floor, not by the
 * broker's push latency — and every downstream expectation should be set accordingly.
 */

import type { OrderStreamHealth } from "./orderUpdateProjection.js";
import type { BrokerId } from "./latencyModel.js";

/** How the order-update capability stands for one broker, independent of socket health. */
export type OrderStreamWiring = "not_built" | "not_wired" | "gated_off" | "armed";

/** What is currently responsible for observing a fill. */
export type FillObservationMechanism = "rest_polling_only" | "stream_primary_rest_reconcile";

export interface BrokerOrderStreamStatus {
  broker: BrokerId;
  wiring: OrderStreamWiring;
  /** The env gate's name, so an operator can find the switch without grepping. */
  gate_env_var: string;
  gate_enabled: boolean;
  /** Live health from the projection, or null when nothing is consuming the stream. */
  health: OrderStreamHealth | null;
  fills_observed_by: FillObservationMechanism;
  /** Plain-language, safe to display verbatim. Never contains a token or account id. */
  detail: string;
}

export interface OrderStreamStatusSnapshot {
  /**
   * The headline an operator should read FIRST. True only when at least one broker's order
   * stream is genuinely delivering updates. False whenever fills depend on REST polling.
   */
  any_stream_live: boolean;
  /**
   * Explicit anti-conflation flag for the UI. When true, the dashboard MUST NOT present a
   * healthy market-data feed as evidence that fills are observed promptly.
   */
  market_data_health_is_not_order_stream_health: true;
  brokers: BrokerOrderStreamStatus[];
}

const GATE_ENV: Readonly<Record<BrokerId, string>> = Object.freeze({
  zerodha: "ZERODHA_ORDER_STREAM_ENABLED",
  dhan: "DHAN_ORDER_STREAM_ENABLED",
});

/**
 * Build the snapshot.
 *
 * `consumers` maps a broker to the projection health of whatever is actually consuming its
 * order stream. A broker ABSENT from the map is reported `not_wired` even when its env gate
 * is on — because an armed gate with no consumer still delivers no fills, and reporting that
 * as "armed" would be a lie an operator could act on.
 */
export function orderStreamStatus(args: {
  brokers: readonly BrokerId[];
  gateEnabled: (broker: BrokerId) => boolean;
  consumers?: ReadonlyMap<BrokerId, OrderStreamHealth>;
  /** Brokers with no implementation at all. */
  notBuilt?: readonly BrokerId[];
}): OrderStreamStatusSnapshot {
  const notBuilt = new Set(args.notBuilt ?? []);
  const brokers = args.brokers.map((broker): BrokerOrderStreamStatus => {
    const gateEnabled = args.gateEnabled(broker);
    const health = args.consumers?.get(broker) ?? null;
    const gateVar = GATE_ENV[broker];

    let wiring: OrderStreamWiring;
    if (notBuilt.has(broker)) wiring = "not_built";
    else if (health === null) wiring = "not_wired";
    else if (!gateEnabled) wiring = "gated_off";
    else wiring = "armed";

    // A fill is observed by the stream ONLY when a consumer exists, the gate is on, and the
    // projection itself reports a usable connection. Anything less is REST polling, and the
    // pending-reconcile state counts as REST because the stream is not yet trusted.
    const streamUsable =
      wiring === "armed" && health !== null && health.state === "LIVE" && health.connected && health.authorised;
    const fills_observed_by: FillObservationMechanism =
      streamUsable ? "stream_primary_rest_reconcile" : "rest_polling_only";

    return {
      broker,
      wiring,
      gate_env_var: gateVar,
      gate_enabled: gateEnabled,
      health,
      fills_observed_by,
      detail: describe(broker, wiring, gateVar, gateEnabled, health),
    };
  });

  return {
    any_stream_live: brokers.some((b) => b.fills_observed_by === "stream_primary_rest_reconcile"),
    market_data_health_is_not_order_stream_health: true,
    brokers,
  };
}

function describe(
  broker: BrokerId,
  wiring: OrderStreamWiring,
  gateVar: string,
  gateEnabled: boolean,
  health: OrderStreamHealth | null,
): string {
  switch (wiring) {
    case "not_built":
      return `No order-update stream implementation for ${broker}; fills are observed by REST polling only.`;
    case "not_wired":
      return (
        `An order-update stream for ${broker} is implemented and unit-tested, but NO running component ` +
        `is consuming it, so it cannot deliver a fill. Fills are observed by REST polling only. ` +
        (gateEnabled
          ? `${gateVar} is set, which does NOT by itself start a consumer.`
          : `${gateVar} is also unset.`) +
        ` This requires supervised live validation before it is relied upon.`
      );
    case "gated_off":
      return `Order-update stream for ${broker} is wired but not armed (${gateVar} is not "true"); fills are observed by REST polling only.`;
    case "armed":
      return health
        ? `Order-update stream for ${broker} armed via ${gateVar}. ${health.detail}`
        : `Order-update stream for ${broker} armed via ${gateVar}.`;
  }
}
