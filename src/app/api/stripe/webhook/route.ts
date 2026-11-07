// Stripe webhook (Phase 2.3). The ONLY thing that may mark an invoice paid.
// Every request must carry a valid Stripe signature; anything else gets a 400
// and touches nothing. Each verified event goes to record_stripe_event()
// (migration 0022), which writes the audit row and, for a completed payment,
// marks the invoice paid in the same transaction, but only when the invoice
// is sent and Stripe's amount and currency match its total exactly.
import Stripe from "stripe";
import { NextResponse } from "next/server";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase";
import { paymentFromEvent } from "@/lib/payments/webhook";
import { onDownloadsBought, onGiftCardIssued, onPaymentReceived } from "@/lib/email/triggers";
import { onBookingPaid } from "@/lib/booking/confirm";

export const dynamic = "force-dynamic";

const cryptoProvider = Stripe.createSubtleCryptoProvider();

export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return NextResponse.json({ error: "missing signature" }, { status: 400 });
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe().webhooks.constructEventAsync(
      body,
      sig,
      env.stripeWebhookSecret(),
      undefined,
      cryptoProvider
    );
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const p = paymentFromEvent(event);

  // Gift card purchase (2.7): issue_gift_card() (migration 0032) writes the
  // audit row and, for a paid session at exactly the purchase price, creates
  // the card in the same transaction. Invoices are never touched here.
  if (p.giftCardPurchaseId) {
    const { data: outcome, error } = await db.rpc("issue_gift_card", {
      p_event_id: event.id,
      p_type: event.type,
      p_livemode: event.livemode,
      p_purchase_id: p.giftCardPurchaseId,
      p_session_id: p.sessionId,
      p_payment_intent_id: p.paymentIntentId,
      p_amount_cents: p.amountCents,
      p_currency: p.currency,
      p_mark_paid: p.markPaid,
      p_payload: event,
    });
    if (error) {
      console.error("stripe webhook: issue_gift_card failed", event.id, error.message);
      return NextResponse.json({ error: "not recorded" }, { status: 500 });
    }
    if (!["gift_card_issued", "recorded", "duplicate"].includes(String(outcome))) {
      console.error("stripe webhook: gift card payment needs attention", event.id, event.type, outcome, p.giftCardPurchaseId);
    }
    // Code email to the buyer and a note to David. Never throws; keyed on
    // the event id so a retry never mails twice.
    if (outcome === "gift_card_issued") await onGiftCardIssued(event.id, p.giftCardPurchaseId);
    return NextResponse.json({ received: true });
  }

  // Paid extra downloads (5.7): fulfill_download_purchase() (migration 0034)
  // writes the audit row and, for a paid session at exactly the purchase
  // amount, creates the paid invoice and grants the photos in one transaction.
  if (p.downloadPurchaseId) {
    const { data: outcome, error } = await db.rpc("fulfill_download_purchase", {
      p_event_id: event.id,
      p_type: event.type,
      p_livemode: event.livemode,
      p_purchase_id: p.downloadPurchaseId,
      p_session_id: p.sessionId,
      p_payment_intent_id: p.paymentIntentId,
      p_amount_cents: p.amountCents,
      p_currency: p.currency,
      p_mark_paid: p.markPaid,
      p_payload: event,
    });
    if (error) {
      console.error("stripe webhook: fulfill_download_purchase failed", event.id, error.message);
      return NextResponse.json({ error: "not recorded" }, { status: 500 });
    }
    if (!["downloads_granted", "recorded", "duplicate"].includes(String(outcome))) {
      console.error("stripe webhook: download purchase needs attention", event.id, event.type, outcome, p.downloadPurchaseId);
    }
    if (outcome === "downloads_granted") await onDownloadsBought(event.id, p.downloadPurchaseId);
    return NextResponse.json({ received: true });
  }

  // A refund names a payment intent, not an invoice; link it to the invoice it paid.
  let invoiceId = p.invoiceId;
  if (!invoiceId && p.paymentIntentId) {
    const { data } = await db
      .from("invoices")
      .select("id")
      .eq("stripe_payment_intent_id", p.paymentIntentId)
      .maybeSingle();
    invoiceId = data?.id ?? null;
  }

  // A refund of a gift card purchase (2.8, from "Refund and void"): logged
  // against the purchase. issue_gift_card only records it (p_mark_paid false).
  if (!invoiceId && !p.sessionId && p.paymentIntentId && event.type === "charge.refunded") {
    const { data: purchase } = await db
      .from("gift_card_purchases")
      .select("id")
      .eq("stripe_payment_intent_id", p.paymentIntentId)
      .maybeSingle();
    if (purchase) {
      const { error } = await db.rpc("issue_gift_card", {
        p_event_id: event.id,
        p_type: event.type,
        p_livemode: event.livemode,
        p_purchase_id: purchase.id,
        p_session_id: null,
        p_payment_intent_id: p.paymentIntentId,
        p_amount_cents: p.amountCents,
        p_currency: p.currency,
        p_mark_paid: false,
        p_payload: event,
      });
      if (error) {
        console.error("stripe webhook: gift card refund not recorded", event.id, error.message);
        return NextResponse.json({ error: "not recorded" }, { status: 500 });
      }
      return NextResponse.json({ received: true });
    }
  }

  const { data: outcome, error } = await db.rpc("record_stripe_event", {
    p_event_id: event.id,
    p_type: event.type,
    p_livemode: event.livemode,
    p_invoice_id: invoiceId,
    p_installment_id: p.installmentId,
    p_session_id: p.sessionId,
    p_payment_intent_id: p.paymentIntentId,
    p_amount_cents: p.amountCents,
    p_currency: p.currency,
    p_mark_paid: p.markPaid,
    p_payload: event,
  });
  // 500 makes Stripe retry later; the event id keeps the retry idempotent.
  if (error) {
    console.error("stripe webhook: record_stripe_event failed", event.id, error.message);
    return NextResponse.json({ error: "not recorded" }, { status: 500 });
  }

  if (!["paid", "installment_paid", "recorded", "duplicate"].includes(String(outcome))) {
    // Money arrived for an invoice that couldn't take it. The audit row is
    // stored; this surfaces it in the Worker logs / Sentry too.
    console.error("stripe webhook: payment needs attention", event.id, event.type, outcome, invoiceId);
  }
  // Receipt (2.5). Never throws; keyed on the event id so it goes out once.
  if ((outcome === "paid" || outcome === "installment_paid") && invoiceId && p.amountCents !== null) {
    await onPaymentReceived(event.id, invoiceId, p.amountCents);
    // Online booking (4.4): follow-up runs once, after the first payment.
    await onBookingPaid(invoiceId);
  }
  return NextResponse.json({ received: true });
}
