"use server";

// David applying or undoing gift cards on an invoice (2.8). The money rules
// are in the database (redeem_gift_card, reverse_gift_card_redemption, 0033).
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth/require-admin";
import { supabaseAdmin } from "@/lib/supabase";
import { normalizeCode } from "@/lib/gift-cards/codes";
import { expireOpenCheckouts, redeemOnInvoice } from "@/lib/gift-cards/redeem";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Step 1: look the card up and show its balance before anything is spent.
export async function previewInvoiceGiftCard(invoiceId: string, formData: FormData) {
  await requireAdmin();
  if (!UUID.test(invoiceId)) redirect("/admin/invoices");
  const code = normalizeCode(String(formData.get("code") ?? ""));
  redirect(code ? `/admin/invoices/${invoiceId}?gc=${code}#gift-cards` : `/admin/invoices/${invoiceId}?gc_error=not_found#gift-cards`);
}

// Step 2: spend it.
export async function applyInvoiceGiftCard(invoiceId: string, code: string) {
  await requireAdmin();
  if (!UUID.test(invoiceId)) redirect("/admin/invoices");
  const result = await redeemOnInvoice(code, invoiceId, "admin");
  revalidatePath(`/admin/invoices/${invoiceId}`);
  redirect(
    result.ok
      ? `/admin/invoices/${invoiceId}?gc_applied=${result.appliedCents}#gift-cards`
      : `/admin/invoices/${invoiceId}?gc_error=${encodeURIComponent(result.reason)}#gift-cards`
  );
}

// Puts a redemption back on the card, only while what it paid is unpaid.
export async function undoInvoiceGiftCard(invoiceId: string, ledgerId: string) {
  await requireAdmin();
  if (!UUID.test(invoiceId) || !UUID.test(ledgerId)) redirect("/admin/invoices");
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("reverse_gift_card_redemption", { p_ledger_id: ledgerId, p_note: "Undone from the invoice page" });
  if (error) throw error;
  // The amount due just went up; a Checkout opened for the lower amount can't be used.
  if (data === "undone") await expireOpenCheckouts(db, invoiceId);
  revalidatePath(`/admin/invoices/${invoiceId}`);
  redirect(`/admin/invoices/${invoiceId}?gc_undo=${encodeURIComponent(String(data))}#gift-cards`);
}
