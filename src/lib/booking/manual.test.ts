// Run with `npm test`. Admin-typed session times (manual bookings).
import { test } from "node:test";
import assert from "node:assert/strict";
import { zonedTimeToInstant } from "./slots.ts";

const NY = "America/New_York";

test("a summer time in New York is UTC-4", () => {
  assert.equal(zonedTimeToInstant("2026-07-04", "10:00", NY)?.toISOString(), "2026-07-04T14:00:00.000Z");
});

test("a winter time in New York is UTC-5", () => {
  assert.equal(zonedTimeToInstant("2026-12-12", "10:00", NY)?.toISOString(), "2026-12-12T15:00:00.000Z");
});

test("the time skipped by spring-forward is refused", () => {
  assert.equal(zonedTimeToInstant("2026-03-08", "02:30", NY), null);
  assert.equal(zonedTimeToInstant("2026-03-08", "03:00", NY)?.toISOString(), "2026-03-08T07:00:00.000Z");
});

test("the repeated fall-back hour resolves to the earlier instant", () => {
  assert.equal(zonedTimeToInstant("2026-11-01", "01:30", NY)?.toISOString(), "2026-11-01T05:30:00.000Z");
});

test("malformed or impossible input is refused", () => {
  assert.equal(zonedTimeToInstant("2026-02-31", "10:00", NY), null);
  assert.equal(zonedTimeToInstant("2026-13-01", "10:00", NY), null);
  assert.equal(zonedTimeToInstant("26-1-1", "10:00", NY), null);
  assert.equal(zonedTimeToInstant("2026-07-04", "25:00", NY), null);
  assert.equal(zonedTimeToInstant("2026-07-04", "24:00", NY), null);
  assert.equal(zonedTimeToInstant("2026-07-04", "ten", NY), null);
  assert.equal(zonedTimeToInstant("2026-07-04", "10:00", "Not/AZone"), null);
});
