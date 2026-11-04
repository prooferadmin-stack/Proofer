// Per-project money summary (Phase 2.5): paid / upcoming / past due across a
// project's invoices. Pure, so the test runner can load it directly.
//
// Drafts and voided invoices don't count: nothing is owed on them. A sent
// invoice with a schedule (2.4) counts installment by installment, each by its
// own due date (falling back to the invoice's); one without counts as a whole.
// Something is past due only once its due date has gone by; no due date means
// due on receipt, which counts as upcoming.
//
// Gift card credit (2.8) counts as paid, and comes off what's still owed.
import { creditFor, type CreditRow } from "../gift-cards/due.ts";

export type SummaryInvoice = {
  id: string;
  status: "draft" | "sent" | "paid" | "void";
  total_cents: number;
  amount_paid_cents: number | null;
  due_date: string | null;
};

export type SummaryInstallment = {
  // Needed to match gift card credit to an installment (2.8).
  id?: string;
  invoice_id: string;
  amount_cents: number;
  due_date: string | null;
  status: "unpaid" | "paid";
};

export type MoneySummary = { paidCents: number; upcomingCents: number; pastDueCents: number };

// `today` is YYYY-MM-DD in the business time zone; dates compare as strings.
export function summarizeProjectMoney(
  invoices: SummaryInvoice[],
  installments: SummaryInstallment[],
  today: string,
  credits: CreditRow[] = []
): MoneySummary {
  const summary: MoneySummary = { paidCents: 0, upcomingCents: 0, pastDueCents: 0 };
  const owe = (cents: number, due: string | null) => {
    if (due !== null && due < today) summary.pastDueCents += cents;
    else summary.upcomingCents += cents;
  };

  for (const inv of invoices) {
    if (inv.status === "paid") {
      summary.paidCents += inv.amount_paid_cents ?? inv.total_cents;
      continue;
    }
    if (inv.status !== "sent") continue;
    const schedule = installments.filter((i) => i.invoice_id === inv.id);
    if (schedule.length === 0) {
      const credit = creditFor(credits, inv.id, null);
      summary.paidCents += credit;
      owe(inv.total_cents - credit, inv.due_date);
      continue;
    }
    for (const i of schedule) {
      if (i.status === "paid") {
        summary.paidCents += i.amount_cents;
        continue;
      }
      const credit = i.id ? creditFor(credits, inv.id, i.id) : 0;
      summary.paidCents += credit;
      owe(i.amount_cents - credit, i.due_date ?? inv.due_date);
    }
  }
  return summary;
}
