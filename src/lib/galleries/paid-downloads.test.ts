import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePriceDollars, pickedIds, quote } from "./paid-downloads.ts";

test("price parsing", () => {
  assert.equal(parsePriceDollars(""), null);
  assert.equal(parsePriceDollars("  "), null);
  assert.equal(parsePriceDollars("15"), 1500);
  assert.equal(parsePriceDollars("$15.5"), 1550);
  assert.equal(parsePriceDollars("15.05"), 1505);
  assert.equal(parsePriceDollars("1"), 100);
  assert.equal(parsePriceDollars("500"), 50000);
  for (const bad of ["0.99", "501", "abc", "15.555", "-5", "1e3", "15,00"]) assert.throws(() => parsePriceDollars(bad), bad);
});

test("quote uses free downloads first", () => {
  assert.deepEqual(quote(10, 3, 1500), { free: 3, paid: 7, totalCents: 10500 });
  assert.deepEqual(quote(2, 3, 1500), { free: 2, paid: 0, totalCents: 0 });
  assert.deepEqual(quote(4, 0, 1500), { free: 0, paid: 4, totalCents: 6000 });
  assert.deepEqual(quote(4, null, 1000), { free: 0, paid: 4, totalCents: 4000 });
  assert.deepEqual(quote(0, 3, 1500), { free: 0, paid: 0, totalCents: 0 });
});

test("picked ids: uuids only, deduped, lowercased", () => {
  const a = "0F8FAD5B-D9CB-469F-A165-70867728950E";
  assert.deepEqual(pickedIds([a, a.toLowerCase(), "x", "1; drop table", ""]), [a.toLowerCase()]);
});
