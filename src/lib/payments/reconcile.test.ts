// Run with `npm test` (Node's built-in runner + type stripping, Node >= 22.18).
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, type AppliedEvent, type StripePaid } from "./reconcile.ts";

const s = (sessionId: string, amountCents: number, kind: StripePaid["kind"] = "invoice"): StripePaid => ({
  sessionId,
  amountCents,
  currency: "usd",
  created: "2026-10-14T15:00:00Z",
  kind,
  invoiceId: kind === "invoice" ? "inv" : null,
});
const e = (sessionId: string | null, amountCents: number, outcome = "paid"): AppliedEvent => ({
  sessionId,
  invoiceId: "inv",
  amountCents,
  outcome,
  receivedAt: "2026-10-14T15:00:05Z",
});

test("a payment applied for the same amount matches", () => {
  const r = reconcile([s("cs_1", 53500)], [e("cs_1", 53500)]);
  assert.deepEqual(r.rows.map((x) => x.status), ["ok"]);
  assert.equal(r.stripeTotal, 53500);
  assert.equal(r.appliedTotal, 53500);
});

test("Stripe-only payments, refused ones and store orders are told apart", () => {
  const r = reconcile(
    [s("cs_old", 53500), s("cs_late", 45000), s("cs_store", 4000, "store"), s("cs_info", 1000)],
    [e("cs_late", 45000, "already_paid"), e("cs_info", 1000, "recorded")]
  );
  const by = Object.fromEntries(r.rows.map((x) => [x.sessionId, x.status]));
  assert.deepEqual(by, { cs_old: "stripe_only", cs_late: "needs_attention", cs_store: "store_order", cs_info: "stripe_only" });
  assert.equal(r.stripeTotal, 53500 + 45000 + 1000); // store orders kept out of the invoice total
  assert.equal(r.appliedTotal, 0);
});

test("installment payments count, amount differences and Proofer-only rows are flagged", () => {
  const r = reconcile([s("cs_dep", 16050), s("cs_bal", 37450)], [e("cs_dep", 16050, "installment_paid"), e("cs_bal", 37000), e("cs_gone", 999)]);
  const by = Object.fromEntries(r.rows.map((x) => [x.sessionId, x.status]));
  assert.deepEqual(by, { cs_dep: "ok", cs_bal: "amount_differs", cs_gone: "proofer_only" });
  // Problems sort first.
  assert.notEqual(r.rows[0].status, "ok");
});

test("gift card sales match their issue events and stay out of the invoice totals", () => {
  const card = { ...e("cs_gc", 39200, "gift_card_issued"), invoiceId: null, giftCard: true };
  const refused = { ...e("cs_gc2", 49000, "amount_mismatch"), invoiceId: null, giftCard: true };
  const r = reconcile([s("cs_gc", 39200, "gift_card"), s("cs_gc2", 49000, "gift_card"), s("cs_1", 53500)], [card, refused, e("cs_1", 53500)]);
  const by = Object.fromEntries(r.rows.map((x) => [x.sessionId, x.status]));
  assert.deepEqual(by, { cs_gc: "ok", cs_gc2: "needs_attention", cs_1: "ok" });
  assert.equal(r.stripeTotal, 53500);
  assert.equal(r.appliedTotal, 53500);
  assert.equal(r.giftCardStripeTotal, 39200 + 49000);
  assert.equal(r.giftCardAppliedTotal, 39200);
});

test("a gift card sale Stripe took but Proofer never issued is flagged", () => {
  const r = reconcile([s("cs_gc", 25000, "gift_card")], []);
  assert.deepEqual(r.rows.map((x) => x.status), ["stripe_only"]);
  assert.equal(r.giftCardAppliedTotal, 0);
});
