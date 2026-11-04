// Run with `npm test`. Gift card prices (Phase 2.7, money).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS, parseWholeDollars, priceChoice, sessionCardPrice, validatePresets, type OfferedSession } from "./pricing.ts";

const headshots: OfferedSession = { id: "st1", name: "Headshots", price_cents: 49000, currency: "usd", active: true, gift_card_offered: true };

test("session cards sell at 20% off and are worth the full session (David's examples)", () => {
  assert.equal(sessionCardPrice(49000, 20), 39200);
  assert.equal(sessionCardPrice(125000, 20), 100000);
  assert.equal(sessionCardPrice(120000, 20), 96000);
  const r = priceChoice(DEFAULT_SETTINGS, { kind: "session", sessionTypeId: "st1" }, headshots);
  assert.deepEqual(r, { ok: true, priced: { kind: "session", faceCents: 49000, amountCents: 39200, sessionTypeId: "st1", sessionLabel: "Headshots" } });
});

test("the discount rounds to the cent and stays within 0 to 50%", () => {
  assert.equal(sessionCardPrice(33333, 20), 26666);
  assert.equal(sessionCardPrice(49000, 0), 49000);
  assert.equal(sessionCardPrice(49000, 90), 24500);
  assert.equal(sessionCardPrice(49000, -5), 49000);
});

test("the session price comes from the server's session row, not the browser", () => {
  const off = { ...headshots, gift_card_offered: false };
  const inactive = { ...headshots, active: false };
  const free = { ...headshots, price_cents: 0 };
  for (const s of [off, inactive, free, null]) {
    assert.equal(priceChoice(DEFAULT_SETTINGS, { kind: "session", sessionTypeId: "st1" }, s).ok, false);
  }
  // A different session row than the one picked is refused.
  assert.equal(priceChoice(DEFAULT_SETTINGS, { kind: "session", sessionTypeId: "st2" }, headshots).ok, false);
});

test("presets must be one of David's amounts and sell at full value", () => {
  const r = priceChoice(DEFAULT_SETTINGS, { kind: "preset", cents: 25000 }, null);
  assert.deepEqual(r, { ok: true, priced: { kind: "amount", faceCents: 25000, amountCents: 25000, sessionTypeId: null, sessionLabel: null } });
  for (const cents of [26000, 1, 0, -25000, 25000.5, Number.NaN]) {
    assert.equal(priceChoice(DEFAULT_SETTINGS, { kind: "preset", cents }, null).ok, false, String(cents));
  }
});

test("custom amounts are whole dollars between the minimum and maximum", () => {
  assert.equal(parseWholeDollars("250"), 25000);
  assert.equal(parseWholeDollars("$1,250.00"), 125000);
  assert.equal(parseWholeDollars("250.50"), null);
  assert.equal(parseWholeDollars("-250"), null);
  assert.equal(parseWholeDollars("1e5"), null);
  assert.equal(parseWholeDollars(""), null);
  const ok = priceChoice(DEFAULT_SETTINGS, { kind: "custom", dollars: "175" }, null);
  assert.ok(ok.ok && ok.priced.faceCents === 17500 && ok.priced.amountCents === 17500);
  assert.equal(priceChoice(DEFAULT_SETTINGS, { kind: "custom", dollars: "99" }, null).ok, false);
  assert.equal(priceChoice(DEFAULT_SETTINGS, { kind: "custom", dollars: "2001" }, null).ok, false);
  assert.equal(priceChoice(DEFAULT_SETTINGS, { kind: "custom", dollars: "2000" }, null).ok, true);
});

test("preset validation mirrors the database rule", () => {
  assert.equal(validatePresets([10000, 15000, 50000], 10000), null);
  assert.ok(validatePresets([12500], 10000));
  assert.ok(validatePresets([5000], 5000));
  assert.ok(validatePresets([10000], 15000));
  assert.ok(validatePresets(Array.from({ length: 13 }, (_, i) => 10000 + i * 5000), 10000));
});
