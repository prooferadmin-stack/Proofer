// Stripe reconciliation (Phase 2.6): does every payment Stripe took show up as
// applied in Proofer, and does every payment Proofer applied exist in Stripe
// for the same amount? Pure, so the matching rules can be tested; the admin
// page loads both sides.

export type StripePaid = {
  sessionId: string;
  amountCents: number;
  currency: string;
  created: string; // ISO
  kind: "invoice" | "store" | "gift_card" | "other";
  invoiceId: string | null;
};

export type AppliedEvent = {
  sessionId: string | null;
  invoiceId: string | null;
  amountCents: number | null;
  // paid | installment_paid | gift_card_issued | already_paid | already_issued |
  // not_payable | amount_mismatch | unknown_invoice | unknown_purchase | recorded
  outcome: string;
  // True for a gift card purchase event (2.7), so totals split invoice vs card.
  giftCard?: boolean;
  receivedAt: string;
};

export type ReconRow = {
  sessionId: string | null;
  invoiceId: string | null;
  amountCents: number;
  when: string;
  status: "ok" | "stripe_only" | "store_order" | "needs_attention" | "proofer_only" | "amount_differs";
  note: string;
};

// downloads_granted (5.7): a download purchase becomes a paid invoice, so it
// counts with invoice payments.
const APPLIED = new Set(["paid", "installment_paid", "gift_card_issued", "downloads_granted"]);

export type ReconResult = {
  rows: ReconRow[];
  // Invoice payments only, as before.
  stripeTotal: number;
  appliedTotal: number;
  // Gift card sales (2.7): Stripe money taken for cards vs cards issued.
  giftCardStripeTotal: number;
  giftCardAppliedTotal: number;
};

export function reconcile(stripe: StripePaid[], events: AppliedEvent[]): ReconResult {
  const rows: ReconRow[] = [];
  const bySession = new Map<string, AppliedEvent[]>();
  for (const e of events) if (e.sessionId) bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e]);
  const seen = new Set<string>();

  for (const s of stripe) {
    seen.add(s.sessionId);
    const evs = bySession.get(s.sessionId) ?? [];
    const applied = evs.find((e) => APPLIED.has(e.outcome));
    const flagged = evs.find((e) => !APPLIED.has(e.outcome) && e.outcome !== "recorded");
    const base = { sessionId: s.sessionId, invoiceId: s.invoiceId ?? applied?.invoiceId ?? null, amountCents: s.amountCents, when: s.created };
    if (applied) {
      rows.push(
        applied.amountCents === s.amountCents
          ? { ...base, status: "ok", note: "Matches" }
          : { ...base, status: "amount_differs", note: `Proofer recorded ${applied.amountCents ?? 0} cents` }
      );
    } else if (s.kind === "store") {
      rows.push({ ...base, status: "store_order", note: "Store order. Orders aren't recorded in Proofer yet (7.3)." });
    } else if (flagged) {
      rows.push({ ...base, status: "needs_attention", note: `Received but not applied: ${flagged.outcome.replace(/_/g, " ")}` });
    } else {
      rows.push({ ...base, status: "stripe_only", note: "Paid in Stripe, but Proofer never recorded it" });
    }
  }

  for (const e of events) {
    if (!APPLIED.has(e.outcome) || (e.sessionId && seen.has(e.sessionId))) continue;
    rows.push({
      sessionId: e.sessionId,
      invoiceId: e.invoiceId,
      amountCents: e.amountCents ?? 0,
      when: e.receivedAt,
      status: "proofer_only",
      note: "Applied in Proofer, but not found in Stripe for this period",
    });
  }

  rows.sort((a, b) => (a.status === "ok" ? 1 : 0) - (b.status === "ok" ? 1 : 0) || b.when.localeCompare(a.when));
  const stripeTotal = stripe.filter((s) => s.kind === "invoice").reduce((n, s) => n + s.amountCents, 0);
  const applied = events.filter((e) => APPLIED.has(e.outcome));
  const appliedTotal = applied.filter((e) => !e.giftCard).reduce((n, e) => n + (e.amountCents ?? 0), 0);
  const giftCardStripeTotal = stripe.filter((s) => s.kind === "gift_card").reduce((n, s) => n + s.amountCents, 0);
  const giftCardAppliedTotal = applied.filter((e) => e.giftCard).reduce((n, e) => n + (e.amountCents ?? 0), 0);
  return { rows, stripeTotal, appliedTotal, giftCardStripeTotal, giftCardAppliedTotal };
}
