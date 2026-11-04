// Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRateLimitedFor } from "./rate-limit.ts";

test("the gift card limiter allows 5 tries per window, then refuses until it resets", () => {
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(isRateLimitedFor("gc:test", 5, 900_000, t0 + i), false);
  assert.equal(isRateLimitedFor("gc:test", 5, 900_000, t0 + 10), true);
  assert.equal(isRateLimitedFor("gc:other", 5, 900_000, t0 + 10), false);
  assert.equal(isRateLimitedFor("gc:test", 5, 900_000, t0 + 900_001), false);
});
