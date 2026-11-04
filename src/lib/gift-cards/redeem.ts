// Spending a gift card on an invoice (Phase 2.8). The money rules live in
// redeem_gift_card() (migration 0033); this wraps it for the /pay page and
// admin, then tidies up around it:
//   * any Stripe Checkout already open for this invoice is expired, because
//     its amount was fixed before the card lowered what's due (a payment
//     through it would no longer match and would need a refund);
//   * when the card fully paid something, the client gets an email (there's
//     no Stripe receipt for card-only payments).
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";
import { stripe } from "@/lib/stripe";
import { isMissingTable } from "@/lib/db-errors";
import { normalizeCode } from "./codes";
import type { CreditRow } from "./due";

export type RedeemResult =
  | { ok: true; giftCardId: string; appliedCents: number; balanceCents: number; invoicePaid: boolean; covered: number }
  | { ok: false; reason: string };

export async function loadCredits(db: SupabaseClient, invoiceId: string): Promise<CreditRow[]> {
  const { data, error } = await db
    .from("gift_card_ledger")
    .select("kind, amount_cents, invoice_id, installment_id")
    .eq("invoice_id", invoiceId);
  if (isMissingTable(error)) return [];
  if (error) throw error;
  return (data ?? []) as CreditRow[];
}

// Credits for many invoices at once (project and contact summaries).
export async function loadCreditsFor(db: SupabaseClient, invoiceIds: string[]): Promise<CreditRow[]> {
  if (invoiceIds.length === 0) return [];
  const { data, error } = await db
    .from("gift_card_ledger")
    .select("kind, amount_cents, invoice_id, installment_id")
    .in("invoice_id", invoiceIds);
  if (isMissingTable(error)) return [];
  if (error) throw error;
  return (data ?? []) as CreditRow[];
}

// Never throws: a Checkout we can't expire is still caught by the webhook
// (amount_mismatch, flagged for David), just less gracefully.
export async function expireOpenCheckouts(db: SupabaseClient, invoiceId: string): Promise<void> {
  try {
    const [{ data: inv }, { data: insts }] = await Promise.all([
      db.from("invoices").select("stripe_checkout_session_id").eq("id", invoiceId).maybeSingle(),
      db.from("invoice_installments").select("stripe_checkout_session_id, status").eq("invoice_id", invoiceId),
    ]);
    const ids = [
      inv?.stripe_checkout_session_id as string | null | undefined,
      ...((insts ?? []).filter((i) => i.status === "unpaid").map((i) => i.stripe_checkout_session_id as string | null)),
    ].filter((s): s is string => typeof s === "string" && s.startsWith("cs_"));
    for (const id of ids) {
      try {
        const s = await stripe().checkout.sessions.retrieve(id);
        if (s.status === "open") await stripe().checkout.sessions.expire(id);
      } catch (err) {
        console.error("gift card: couldn't expire Checkout", id, err);
      }
    }
  } catch (err) {
    console.error("gift card: expiring open Checkouts failed", invoiceId, err);
  }
}

export async function redeemOnInvoice(rawCode: string, invoiceId: string, actor: "client" | "admin"): Promise<RedeemResult> {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, reason: "not_found" };
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("redeem_gift_card", { p_code: code, p_invoice_id: invoiceId, p_actor: actor });
  if (error) throw error;
  const r = data as Record<string, unknown>;
  if (r.ok !== true) return { ok: false, reason: String(r.reason ?? "unknown") };
  const result: RedeemResult = {
    ok: true,
    giftCardId: String(r.gift_card_id),
    appliedCents: Number(r.applied_cents),
    balanceCents: Number(r.balance_cents),
    invoicePaid: r.invoice_paid === true,
    covered: Number(r.covered ?? 0),
  };
  await expireOpenCheckouts(db, invoiceId);
  if (result.covered > 0) {
    const { onGiftCardCovered } = await import("@/lib/email/triggers");
    await onGiftCardCovered(invoiceId, result);
  }
  return result;
}
