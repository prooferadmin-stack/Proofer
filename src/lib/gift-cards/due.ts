// Amount due after gift card credit (Phase 2.8). Mirrors the database's
// gift_card_credit_cents() (migration 0033): credit on a target is minus the
// sum of its redeem and reverse ledger rows. Pure, so pages, Checkout,
// reminders and the project summary share one rule; the database checks it
// again when Stripe's payment arrives (record_stripe_event).

export type CreditRow = {
  kind: string; // issue | redeem | reverse | void
  amount_cents: number;
  invoice_id: string | null;
  installment_id: string | null;
};

export type DueInstallment = { id: string; amount_cents: number; status: string; position: number };

// Live credit on one target: the invoice itself (installmentId null) or one installment.
export function creditFor(rows: CreditRow[], invoiceId: string, installmentId: string | null): number {
  let sum = 0;
  for (const r of rows) {
    if (r.kind !== "redeem" && r.kind !== "reverse") continue;
    if (r.invoice_id !== invoiceId || (r.installment_id ?? null) !== installmentId) continue;
    sum += r.amount_cents;
  }
  return 0 - sum; // never -0
}

// All live credit on an invoice, across its installments.
export function invoiceCredit(rows: CreditRow[], invoiceId: string): number {
  let sum = 0;
  for (const r of rows) if ((r.kind === "redeem" || r.kind === "reverse") && r.invoice_id === invoiceId) sum += r.amount_cents;
  return 0 - sum; // never -0
}

export type NextPayment = {
  installmentId: string | null;
  // What Stripe should charge now.
  dueCents: number;
  creditCents: number;
} | null;

// The payment a client makes next: the invoice's amount due, or the earliest
// unpaid installment's. null when nothing is left to pay.
export function nextPayment(
  invoice: { id: string; total_cents: number },
  installments: DueInstallment[],
  rows: CreditRow[]
): NextPayment {
  if (installments.length === 0) {
    const credit = creditFor(rows, invoice.id, null);
    const due = invoice.total_cents - credit;
    return due > 0 ? { installmentId: null, dueCents: due, creditCents: credit } : null;
  }
  const ordered = [...installments].sort((a, b) => a.position - b.position);
  for (const i of ordered) {
    if (i.status === "paid") continue;
    const credit = creditFor(rows, invoice.id, i.id);
    const due = i.amount_cents - credit;
    if (due > 0) return { installmentId: i.id, dueCents: due, creditCents: credit };
  }
  return null;
}

// Everything still owed on an invoice after card credit.
export function invoiceDue(invoice: { id: string; total_cents: number }, installments: DueInstallment[], rows: CreditRow[]): number {
  if (installments.length === 0) return Math.max(0, invoice.total_cents - creditFor(rows, invoice.id, null));
  return installments
    .filter((i) => i.status !== "paid")
    .reduce((n, i) => n + Math.max(0, i.amount_cents - creditFor(rows, invoice.id, i.id)), 0);
}

// Reasons redeem_gift_card() refuses. The client only ever sees one generic
// message (so the page can't be used to probe codes); David sees these.
export const REDEEM_REFUSALS: Record<string, string> = {
  not_found: "No gift card has that code.",
  void: "That gift card was voided.",
  expired: "That gift card has expired.",
  empty: "That gift card has no balance left.",
  invoice_not_payable: "This invoice isn't open for payment (draft, paid or void).",
  booking_hold: "This invoice is holding an online booking; the client pays that by card first.",
  currency: "The card and the invoice are in different currencies.",
  nothing_due: "Nothing is left to pay on this invoice.",
};
