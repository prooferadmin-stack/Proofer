// Run with `npm test`. The generator itself is in SQL and tested by
// supabase/tests/0032_gift_cards_test.sql (10,000 codes, shape, alphabet).
import { test } from "node:test";
import assert from "node:assert/strict";
import { CODE_ALPHABET, formatCode, normalizeCode } from "./codes.ts";

test("the alphabet has no look-alike characters", () => {
  assert.equal(CODE_ALPHABET.length, 31);
  for (const c of "01ILO") assert.ok(!CODE_ALPHABET.includes(c), c);
  assert.equal(new Set(CODE_ALPHABET).size, 31);
});

test("codes match regardless of case, spaces, dashes and the DMP prefix", () => {
  const stored = "DMP7K3QX9PAM2RT";
  for (const typed of ["DMP-7K3Q-X9PA-M2RT", "dmp-7k3q-x9pa-m2rt", " dmp 7k3q x9pa m2rt ", "7K3Q-X9PA-M2RT", "DMP7K3QX9PAM2RT"]) {
    assert.equal(normalizeCode(typed), stored, typed);
  }
});

test("anything that can't be a code is refused before any lookup", () => {
  for (const bad of ["", "DMP-7K3Q-X9PA", "DMP-7K3Q-X9PA-M2RTX", "DMP-0K3Q-X9PA-M2RT", "DMP-IK3Q-X9PA-M2RT", "x' or 1=1", "A".repeat(100), null, undefined]) {
    assert.equal(normalizeCode(bad as string), null, String(bad));
  }
});

test("stored codes display in groups of four", () => {
  assert.equal(formatCode("DMP7K3QX9PAM2RT"), "DMP-7K3Q-X9PA-M2RT");
  assert.equal(normalizeCode(formatCode("DMP7K3QX9PAM2RT")), "DMP7K3QX9PAM2RT");
});
