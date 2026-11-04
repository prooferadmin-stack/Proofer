// Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cardAmount, cardDate, cardSummary } from "./display.ts";

test("card amounts drop the cents when whole", () => {
  assert.equal(cardAmount(49000), "$490");
  assert.equal(cardAmount(125000), "$1,250");
  assert.equal(cardAmount(1250), "$12.50");
});

test("session cards say what they cover", () => {
  assert.equal(cardSummary(49000, "Headshot Session"), "$490 · Headshot Session at today's price");
  assert.equal(cardSummary(25000, null), "$250");
});

test("the expiry date is the Eastern calendar date", () => {
  // 02:00 UTC on Nov 5 is still Nov 4 in Savannah.
  assert.equal(cardDate("2031-11-05T02:00:00Z"), "November 4, 2031");
});
