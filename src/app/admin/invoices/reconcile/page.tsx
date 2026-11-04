// Stripe reconciliation (Phase 2.6, review: money). Read-only: compares the
// Checkout payments Stripe completed in the last 90 days with the payments
// Proofer applied (payment_events), and lists anything that doesn't line up.
import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase";
import { stripe } from "@/lib/stripe";
import { formatCents } from "../money";
import { formatDateTime } from "@/lib/dates";
import { isMissingTable } from "@/lib/db-errors";
import { reconcile, type AppliedEvent, type StripePaid } from "@/lib/payments/reconcile";

export const dynamic = "force-dynamic";

const DAYS = 90;
const TONE: Record<string, string> = {
  ok: "green",
  stripe_only: "red",
  needs_attention: "red",
  amount_differs: "red",
  proofer_only: "amber",
  store_order: "blue",
};
const LABEL: Record<string, string> = {
  ok: "Matches",
  stripe_only: "Not recorded",
  needs_attention: "Needs attention",
  amount_differs: "Amount differs",
  proofer_only: "Not in Stripe",
  store_order: "Store order",
};

export default async function ReconcilePage() {
  const since = Math.floor(Date.now() / 1000) - DAYS * 86400;
  let stripeRows: StripePaid[] = [];
  let stripeError: string | null = null;
  try {
    for await (const sess of stripe().checkout.sessions.list({ created: { gte: since }, status: "complete", limit: 100 })) {
      if (sess.payment_status !== "paid") continue;
      stripeRows.push({
        sessionId: sess.id,
        amountCents: sess.amount_total ?? 0,
        currency: sess.currency ?? "usd",
        created: new Date(sess.created * 1000).toISOString(),
        kind: sess.metadata?.invoice_id
          ? "invoice"
          : sess.metadata?.kind === "store_order"
            ? "store"
            : sess.metadata?.kind === "gift_card"
              ? "gift_card"
              : "other",
        invoiceId: sess.metadata?.invoice_id ?? null,
      });
      if (stripeRows.length >= 500) break;
    }
  } catch (err) {
    stripeError = err instanceof Error ? err.message : "Couldn't reach Stripe";
    stripeRows = [];
  }

  const { data, error } = await supabaseAdmin()
    .from("payment_events")
    .select("*")
    .gte("received_at", new Date(since * 1000).toISOString());
  if (error && !isMissingTable(error)) throw error;
  const events: AppliedEvent[] = (data ?? []).map((r) => ({
    sessionId: r.checkout_session_id as string | null,
    invoiceId: r.invoice_id as string | null,
    amountCents: r.amount_cents as number | null,
    outcome: r.outcome as string,
    receivedAt: r.received_at as string,
    // Column from migration 0032; absent before it runs.
    giftCard: !!(r as { gift_card_purchase_id?: string | null }).gift_card_purchase_id,
  }));

  const { rows, stripeTotal, appliedTotal, giftCardStripeTotal, giftCardAppliedTotal } = reconcile(stripeRows, events);
  const problems = rows.filter((r) => r.status !== "ok" && r.status !== "store_order").length;

  return (
    <main>
      <Link className="back" href="/admin/invoices">
        ← Invoices
      </Link>
      <div className="pagehead">
        <h1>Check against Stripe</h1>
      </div>
      <p className="muted">Card payments Stripe completed in the last {DAYS} days, compared with what Proofer recorded. Nothing here changes any money.</p>
      {stripeError && <p className="notice">Couldn&apos;t load payments from Stripe: {stripeError}</p>}
      <dl className="ph-money" style={{ margin: "var(--sp-4) 0" }}>
        <div>
          <dd>{formatCents(stripeTotal)}</dd>
          <dt>invoice payments in Stripe</dt>
        </div>
        <div>
          <dd>{formatCents(appliedTotal)}</dd>
          <dt>applied in Proofer</dt>
        </div>
        {(giftCardStripeTotal > 0 || giftCardAppliedTotal > 0) && (
          <>
            <div>
              <dd>{formatCents(giftCardStripeTotal)}</dd>
              <dt>gift card sales in Stripe</dt>
            </div>
            <div>
              <dd>{formatCents(giftCardAppliedTotal)}</dd>
              <dt>gift cards issued in Proofer</dt>
            </div>
          </>
        )}
        <div className={problems > 0 ? "late" : undefined}>
          <dd>{problems}</dd>
          <dt>{problems === 1 ? "thing to check" : "things to check"}</dt>
        </div>
      </dl>
      {rows.length === 0 ? (
        <p className="muted">No payments in this period.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Result</th>
              <th>When</th>
              <th>Amount</th>
              <th>Invoice</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={(r.sessionId ?? "x") + i}>
                <td>
                  <span className={`st ${TONE[r.status]}`}>{LABEL[r.status]}</span>
                </td>
                <td>{formatDateTime(r.when)}</td>
                <td>{formatCents(r.amountCents)}</td>
                <td>{r.invoiceId ? <Link href={`/admin/invoices/${r.invoiceId}`}>Open</Link> : "—"}</td>
                <td className="muted">{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
