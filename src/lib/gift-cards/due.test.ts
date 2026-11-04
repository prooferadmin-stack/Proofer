// Run with `npm test`. Amount due after gift card credit (2.8, money).
import { test } from "node:test";
import assert from "node:assert/strict";
import { creditFor, invoiceCredit, invoiceDue, nextPayment, type CreditRow } from "./due.ts";

const INV = "inv";
const row = (kind: string, cents: number, inst: string | null = null, inv = INV): CreditRow => ({ kind, amount_cents: cents, invoice_id: inv, installment_id: inst });

test("credit is the live redemptions, undos and other invoices left out", () => {
  const rows = [row("issue", 50000, null, null as unknown as string), row("redeem", -30000), row("redeem", -5000), row("reverse", 5000), row("redeem", -999, null, "other")];
  assert.equal(creditFor(rows, INV, null), 30000);
  assert.equal(invoiceCredit(rows, INV), 30000);
});

test("an invoice without a schedule owes its total less credit", () => {
  const inv = { id: INV, total_cents: 85000 };
  assert.deepEqual(nextPayment(inv, [], []), { installmentId: null, dueCents: 85000, creditCents: 0 });
  assert.deepEqual(nextPayment(inv, [], [row("redeem", -50000)]), { installmentId: null, dueCents: 35000, creditCents: 50000 });
  assert.equal(nextPayment(inv, [], [row("redeem", -85000)]), null);
  assert.equal(invoiceDue(inv, [], [row("redeem", -50000)]), 35000);
});

test("a schedule pays the earliest installment with anything left, less its own credit", () => {
  const inv = { id: INV, total_cents: 50000 };
  const sched = [
    { id: "b", amount_cents: 30000, status: "unpaid", position: 2 },
    { id: "a", amount_cents: 20000, status: "paid", position: 1 },
  ];
  assert.deepEqual(nextPayment(inv, sched, [row("redeem", -20000, "a"), row("redeem", -5000, "b")]), { installmentId: "b", dueCents: 25000, creditCents: 5000 });
  assert.equal(invoiceDue(inv, sched, [row("redeem", -5000, "b")]), 25000);
  assert.equal(nextPayment(inv, [{ ...sched[0], status: "paid" }, sched[1]], []), null);
});

test("an installment fully covered by credit is skipped", () => {
  const inv = { id: INV, total_cents: 50000 };
  const sched = [
    { id: "a", amount_cents: 20000, status: "unpaid", position: 1 },
    { id: "b", amount_cents: 30000, status: "unpaid", position: 2 },
  ];
  assert.equal(nextPayment(inv, sched, [row("redeem", -20000, "a")])?.installmentId, "b");
});
