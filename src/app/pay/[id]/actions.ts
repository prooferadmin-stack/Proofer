"use server";

// Creates a Stripe Checkout Session for a single invoice (test mode is just
// whichever STRIPE_SECRET_KEY is configured — nothing here branches on it).
//
// Money-code care: the whole invoice total (already server-computed and
// stored on the invoice by task 2.1's actions.ts) is sent to Stripe as one
// line item, rather than trying to replicate discount/tax as separate Stripe
// line items — this guarantees the amount Stripe charges always matches
// invoices.total_cents exactly, which task 2.6's reconciliation check
// depends on. Nothing here can mark the invoice paid; only the signature-
// verified webhook built in task 2.3 is allowed to do that.
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { isActionRateLimited, isRateLimitedFor } from "@/lib/rate-limit";
import { loadCredits, redeemOnInvoice } from "@/lib/gift-cards/redeem";
import { nextPayment } from "@/lib/gift-cards/due";
import { supabaseAdmin } from "@/lib/supabase";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import type { Invoice, InvoiceInstallment } from "@/app/admin/invoices/types";
import { isMissingTable } from "@/lib/db-errors";
import { CHECKOUT_EXPIRY_MINUTES, HOLD_PAST_CHECKOUT_MINUTES } from "@/lib/booking/hold";

export async function createCheckoutSession(invoiceId: string) {
  if (await isActionRateLimited(`pay:${invoiceId}`)) redirect(`/pay/${invoiceId}?error=limited`);
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("invoices")
    .select("*, projects(title)")
    .eq("id", invoiceId)
    .single();
  if (error || !data) throw new Error("Invoice not found");

  const invoice = data as unknown as Invoice & { projects: { title: string } | null };

  if (invoice.status !== "sent") {
    throw new Error("Only a sent invoice can be paid");
  }
  if (invoice.total_cents <= 0) {
    throw new Error("Invoice total must be greater than zero");
  }

  // An online booking's first payment pays for a held time (4.4). Extend the
  // hold past this Checkout session's expiry, or send the client back to
  // pick a time if the hold is gone. Card only, so no payment can land days
  // later on a time someone else has since booked.
  const { data: booking, error: bookingError } = await db
    .from("bookings")
    .select("id, status")
    .eq("invoice_id", invoice.id)
    .maybeSingle();
  if (bookingError && !isMissingTable(bookingError)) throw bookingError;
  if (booking?.status === "canceled") redirect(`/pay/${invoice.id}?error=booking_canceled`);
  const holding = booking?.status === "pending_payment";
  if (holding) {
    const until = new Date(Date.now() + (CHECKOUT_EXPIRY_MINUTES + HOLD_PAST_CHECKOUT_MINUTES) * 60_000);
    const { data: kept, error: holdError } = await db.rpc("extend_booking_hold", {
      p_booking_id: booking.id,
      p_hold_until: until.toISOString(),
    });
    if (holdError) throw holdError;
    if (!kept) redirect(`/pay/${invoice.id}?error=hold_expired`);
  }

  // With a payment schedule (2.4) the client pays the earliest unpaid
  // installment, for exactly its stored amount; the webhook checks it again.
  const { data: schedule, error: scheduleError } = await db
    .from("invoice_installments")
    .select("id, label, amount_cents, status, position")
    .eq("invoice_id", invoice.id)
    .order("position", { ascending: true });
  // Missing table = migration 0023 not run here yet: no schedules exist.
  if (scheduleError && !isMissingTable(scheduleError)) throw scheduleError;
  const installments = (schedule ?? []) as Pick<InvoiceInstallment, "id" | "label" | "amount_cents" | "status" | "position">[];
  // Gift card credit (2.8) lowers what's due; Stripe charges exactly the
  // amount due, which record_stripe_event checks again.
  const pay = nextPayment(invoice, installments, await loadCredits(db, invoice.id));
  if (!pay) throw new Error("Every payment on this invoice is already made");
  const next = pay.installmentId ? (installments.find((i) => i.id === pay.installmentId) ?? null) : null;

  const title = invoice.projects?.title ? `Invoice: ${invoice.projects.title}` : "Invoice";
  const baseUrl = env.appBaseUrl();
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: invoice.currency,
          product_data: { name: next ? `${title} (${next.label})` : title },
          unit_amount: pay.dueCents,
        },
        quantity: 1,
      },
    ],
    ...(holding
      ? {
          payment_method_types: ["card" as const],
          expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRY_MINUTES * 60,
        }
      : {}),
    client_reference_id: invoice.id,
    metadata: next ? { invoice_id: invoice.id, installment_id: next.id } : { invoice_id: invoice.id },
    success_url: `${baseUrl}/pay/${invoice.id}/success`,
    cancel_url: `${baseUrl}/pay/${invoice.id}`,
  });
  if (!session.url) throw new Error("Stripe did not return a Checkout URL");

  const { error: updateError } = next
    ? await db.from("invoice_installments").update({ stripe_checkout_session_id: session.id }).eq("id", next.id)
    : await db.from("invoices").update({ stripe_checkout_session_id: session.id }).eq("id", invoice.id);
  if (updateError) throw updateError;

  redirect(session.url);
}

// "Have a gift card?" on /pay (2.8). Rate limited per IP and per invoice
// (5 tries per 15 minutes), and every refusal shows the same message, so the
// page can't be used to find out which codes exist.
export async function applyGiftCard(invoiceId: string, formData: FormData) {
  const h = await headers();
  const ip = h.get("cf-connecting-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const WINDOW = 15 * 60 * 1000;
  // Both counters advance on every try.
  const byIp = isRateLimitedFor(`gc-ip:${ip}`, 5, WINDOW);
  const byInvoice = isRateLimitedFor(`gc-inv:${invoiceId}`, 5, WINDOW);
  if (byIp || byInvoice) redirect(`/pay/${invoiceId}?error=limited#gift-card`);
  if (!/^[0-9a-f-]{36}$/.test(invoiceId)) redirect("/");

  const result = await redeemOnInvoice(String(formData.get("code") ?? ""), invoiceId, "client");
  if (!result.ok) redirect(`/pay/${invoiceId}?error=gift_card#gift-card`);
  redirect(`/pay/${invoiceId}?applied=${result.appliedCents}#gift-card`);
}
