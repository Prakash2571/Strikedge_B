/**
 * Shared construction helper for the switch suite.
 *
 * `ActiveBrokerManager` takes a wide dependency object because it owns both brokers'
 * runtimes. Every field below is an inert stub: nothing here can open a socket, load an
 * instrument universe, price a leg or reach a broker. The manager under test is the REAL
 * compiled class from dist/, so the restoration semantics being asserted are the ones
 * that actually ship.
 */

/** A Kite client stub that holds no token and cannot call a broker. */
function stubKite() {
  return {
    getApiKey: () => "",
    getAccessToken: () => null,
    clearSession: () => {},
    installProvidedToken: () => {},
    getInstruments: async () => [],
    getQuoteFull: async () => ({}),
    getBasketMargin: async () => ({}),
  };
}

/** A ticker-hub stub that records nothing and connects to nothing. */
function stubHub() {
  return {
    addTickListener: () => () => {},
    addConnectionListener: () => () => {},
    retain: () => () => {},
    seed: () => {},
    ingestExternalTicks: () => {},
    setExternalConnected: () => {},
    getLatestTick: () => null,
    subscribeTokens: () => {},
    unsubscribeTokens: () => {},
    subscribedCount: () => 0,
    isConnected: () => false,
  };
}

/**
 * Construct a real ActiveBrokerManager with `DEFAULT_ACTIVE_BROKER` set to `envDefault`
 * for the duration of construction only (the manager reads the variable in its field
 * initialiser, so the value must be in place at `new` time and is restored immediately
 * after — leaving it set would leak into sibling tests).
 *
 * Pass `envDefault === null` to construct with the variable UNSET, which is how the
 * "Zerodha remains the default when the variable is unset" case is exercised.
 */
export async function makeManager(envDefault) {
  const registryMod = await import("../../dist/brokers/registry.js");
  const saved = process.env.DEFAULT_ACTIVE_BROKER;
  if (envDefault === null) delete process.env.DEFAULT_ACTIVE_BROKER;
  else process.env.DEFAULT_ACTIVE_BROKER = envDefault;
  try {
    return new registryMod.ActiveBrokerManager({
      kite: stubKite(),
      tickerHub: stubHub(),
      boxConfig: () => ({}),
      istDayKey: () => "2026-09-08",
      zerodhaCredentials: () => ({ apiKey: "", accessToken: null }),
      onBoxLaneTicks: () => {},
      onBoxLaneConnection: () => {},
      onDhanTicks: () => {},
      onDhanConnection: () => {},
      onSessionLost: () => {},
    });
  } finally {
    if (saved === undefined) delete process.env.DEFAULT_ACTIVE_BROKER;
    else process.env.DEFAULT_ACTIVE_BROKER = saved;
  }
}
