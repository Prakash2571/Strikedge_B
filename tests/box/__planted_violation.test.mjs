import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { installHermeticNetwork } from "../helpers/hermeticNetwork.mjs";

// PLANTED EGRESS PROBE — neutralised.
//
// This file was planted to make a REAL outbound call to the Dhan scrip-master
// fallback URL, verifying that the egress scan is meaningful (it must catch a genuine
// dial-out, not merely pass cosmetically). With the hermetic guard armed the same call
// is served from the checked-in fixture and never reaches the network, which is exactly
// the property the whole change enforces: no test contacts a real broker.
// The comment below mentions images.dhan.co and must be IGNORED (it is not a URL fetch).
let hermetic;
before(() => {
  hermetic = installHermeticNetwork();
});
after(() => {
  hermetic?.restore();
});

test("planted", async () => {
  const url = "https://images.dhan.co/api-data/api-scrip-master.csv";
  const res = await fetch(url);
  // The guard serves the fixture instead of dialling out; prove the call was intercepted.
  assert.equal(res.ok, true);
  const csv = await res.text();
  assert.ok(csv.length > 0, "the scrip master was served from the fixture, not the network");
});
