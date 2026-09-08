/**
 * istClock — the IST day boundary and the daily scheduler.
 *
 * Proves the fixed +5:30 arithmetic agrees with `boxSupport.istDayKey` (so a day
 * means one thing everywhere), that "before/after 09:00" is decided correctly, and
 * that the next-fire delay is computed from the wall clock (no uptime drift).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  istDayKey,
  istMinutesOfDay,
  isAtOrAfterIstTime,
  msUntilNextDailyTime,
  parseHhMm,
} from "../../dist/tokens/istClock.js";
import { istInstant } from "./helpers.mjs";

/** Local copy of the boxSupport arithmetic to prove agreement. */
function boxSupportIstDayKey(at) {
  const ist = new Date(at + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

test("istDayKey matches the boxSupport +5:30 arithmetic across a day boundary", () => {
  // 2026-09-08 23:45 UTC is 2026-09-09 05:15 IST → the IST day has already rolled.
  const near = Date.UTC(2026, 8, 8, 23, 45, 0);
  assert.equal(istDayKey(near), boxSupportIstDayKey(near));
  assert.equal(istDayKey(near), "2026-09-09");

  // 2026-09-08 18:20 UTC is 2026-09-08 23:50 IST → still the 8th.
  const before = Date.UTC(2026, 8, 8, 18, 20, 0);
  assert.equal(istDayKey(before), boxSupportIstDayKey(before));
  assert.equal(istDayKey(before), "2026-09-08");
});

test("istMinutesOfDay and isAtOrAfterIstTime read IST wall time regardless of server tz", () => {
  const at0900 = istInstant("2026-09-08", "09:00");
  assert.equal(istMinutesOfDay(at0900), 9 * 60);
  assert.equal(isAtOrAfterIstTime(at0900, "09:00"), true);
  assert.equal(isAtOrAfterIstTime(istInstant("2026-09-08", "08:59"), "09:00"), false);
  assert.equal(isAtOrAfterIstTime(istInstant("2026-09-08", "09:01"), "09:00"), true);
});

test("parseHhMm rejects malformed times", () => {
  assert.equal(parseHhMm("09:00"), 540);
  assert.equal(parseHhMm("9:05"), 545);
  assert.throws(() => parseHhMm("9"), /HH:MM/);
  assert.throws(() => parseHhMm("25:00"), /HH:MM|hours/);
  assert.throws(() => parseHhMm("09:60"), /HH:MM/);
});

test("msUntilNextDailyTime fires at 09:00 today when before, tomorrow when after — no uptime drift", () => {
  const before = istInstant("2026-09-08", "08:20"); // 40 min before 09:00
  assert.equal(msUntilNextDailyTime(before, "09:00"), 40 * 60_000);

  const after = istInstant("2026-09-08", "09:30"); // 23h30m to tomorrow 09:00
  assert.equal(msUntilNextDailyTime(after, "09:00"), (23 * 60 + 30) * 60_000);

  // The delay depends on the wall time, not on how long the process has been up:
  // two calls at the same instant give the same delay.
  const t = istInstant("2026-09-08", "07:15");
  assert.equal(msUntilNextDailyTime(t, "09:00"), msUntilNextDailyTime(t, "09:00"));
  assert.equal(msUntilNextDailyTime(t, "09:00"), (60 + 45) * 60_000);
});

test("sub-minute seconds are subtracted so the fire lands on the minute", () => {
  const t = istInstant("2026-09-08", "08:59") + 30_000; // 08:59:30 IST
  // 30s to 09:00.
  assert.equal(msUntilNextDailyTime(t, "09:00"), 30_000);
});
