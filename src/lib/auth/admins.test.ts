// Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_EMAILS, isAdminEmail } from "./admins.ts";

test("allow-list entries are stored lowercased and trimmed", () => {
  for (const email of ADMIN_EMAILS) assert.equal(email, email.trim().toLowerCase());
});

test("allow-list is the studio email only, which also gets admin notices", () => {
  assert.deepEqual(ADMIN_EMAILS, ["davidmonroephotos@gmail.com"]);
});

test("admin email matches regardless of case and surrounding space", () => {
  assert.equal(isAdminEmail("davidmonroephotos@gmail.com"), true);
  assert.equal(isAdminEmail("DavidMonroePhotos@gmail.com"), true);
  assert.equal(isAdminEmail("  davidmonroephotos@gmail.com "), true);
});

test("anyone else, or no email, is refused", () => {
  assert.equal(isAdminEmail("david.draper86@gmail.com"), false);
  assert.equal(isAdminEmail("client@example.com"), false);
  assert.equal(isAdminEmail("davidmonroephotos@gmail.com.evil.com"), false);
  assert.equal(isAdminEmail("xdavidmonroephotos@gmail.com"), false);
  assert.equal(isAdminEmail(""), false);
  assert.equal(isAdminEmail(null), false);
  assert.equal(isAdminEmail(undefined), false);
});
