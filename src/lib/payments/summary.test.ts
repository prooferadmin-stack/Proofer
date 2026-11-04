// Run with `npm test` (Node's built-in runner + type stripping, Node >= 22.18).
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeProjectMoney, type SummaryInvoice } from "./summary.ts";

const TODAY = "2026-10-14";
const inv = (o: Partial<SummaryInvoice> & { id: string }): SummaryInvoice => ({
  status: "sent",
  total_cents: 10000,
  amount_paid_cents: null,
  due_date: null,
  ...o,
});

test("drafts and voids don't count; paid uses the amount actually paid", () => {
  const s = summarizeProjectMoney(
    [
      inv({ id: "a", status: "draft" }),
      inv({ id: "b", status: "void" }),
      inv({ id: "c", status: "paid", total_cents: 53500, amount_paid_cents: 53500 }),
    ],
    [],
    TODAY
  );
  assert.deepEqual(s, { paidCents: 53500, upcomingCents: 0, pastDueCents: 0 });
});

test("sent invoices are upcoming until their due date has passed", () => {
  const s = summarizeProjectMoney(
    [
      inv({ id: "a", due_date: "2026-10-13" }),
      inv({ id: "b", due_date: TODAY }),
      inv({ id: "c", due_date: null }),
      inv({ id: "d", due_date: "2026-12-01" }),
    ],
    [],
    TODAY
  );
  assert.deepEqual(s, { paidCents: 0, upcomingCents: 30000, pastDueCents: 10000 });
});

test("scheduled invoices count installment by installment", () => {
  const s = summarizeProjectMoney(
    [inv({ id: "a", total_cents: 53500, due_date: "2026-11-14" })],
    [
      { invoice_id: "a", amount_cents: 16050, due_date: "2026-10-01", status: "paid" },
      { invoice_id: "a", amount_cents: 10000, due_date: "2026-10-10", status: "unpaid" },
      { invoice_id: "a", amount_cents: 27450, due_date: null, status: "unpaid" },
      { invoice_id: "other", amount_cents: 999, due_date: null, status: "unpaid" },
    ],
    TODAY
  );
  // The last installment has no date, so it falls back to the invoice's (Nov 14).
  assert.deepEqual(s, { paidCents: 16050, upcomingCents: 27450, pastDueCents: 10000 });
});

test("a fully paid scheduled invoice counts once, as paid", () => {
  const s = summarizeProjectMoney(
    [inv({ id: "a", status: "paid", total_cents: 20000, amount_paid_cents: 20000 })],
    [
      { invoice_id: "a", amount_cents: 5000, due_date: null, status: "paid" },
      { invoice_id: "a", amount_cents: 15000, due_date: null, status: "paid" },
    ],
    TODAY
  );
  assert.deepEqual(s, { paidCents: 20000, upcomingCents: 0, pastDueCents: 0 });
});

test("gift card credit counts as paid and comes off what's owed", () => {
  const inv = (id: string, total: number, due: string | null = null) =>
    ({ id, status: "sent" as const, total_cents: total, amount_paid_cents: null, due_date: due });
  const credit = (invoice_id: string, cents: number, installment_id: string | null = null) =>
    ({ kind: "redeem", amount_cents: -cents, invoice_id, installment_id });
  const s = summarizeProjectMoney(
    [inv("a", 85000, "2026-01-01"), inv("b", 50000)],
    [
      { id: "b1", invoice_id: "b", amount_cents: 20000, due_date: null, status: "paid" },
      { id: "b2", invoice_id: "b", amount_cents: 30000, due_date: null, status: "unpaid" },
    ],
    "2026-11-04",
    [credit("a", 50000), credit("b", 20000, "b1"), credit("b", 5000, "b2"), { kind: "reverse", amount_cents: 1000, invoice_id: "a", installment_id: null }]
  );
  assert.deepEqual(s, { paidCents: 49000 + 20000 + 5000, upcomingCents: 25000, pastDueCents: 36000 });
});
