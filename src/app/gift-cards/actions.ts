"use server";

// Opens Stripe Checkout for a gift card (Phase 2.7, money). Nothing here
// creates a card: it fixes the price on a pending purchase row, from the
// settings and (for a session card) the session type's price as stored right
// now, and sends exactly that amount to Stripe. Only the verified webhook,
// through issue_gift_card() (migration 0032), turns a paid purchase into a
// card, and only for that exact amount.
import { redirect } from "next/navigation";
import { isActionRateLimited } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/supabase";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { getGiftCardSettings } from "@/lib/gift-cards/settings";
import { priceChoice, type Choice, type OfferedSession } from "@/lib/gift-cards/pricing";
import { cardSummary } from "@/lib/gift-cards/display";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function text(formData: FormData, name: string): string | null {
  const v = String(formData.get(name) ?? "").trim();
  return v.length > 0 ? v : null;
}

function back(error: string): never {
  redirect(`/gift-cards?error=${encodeURIComponent(error)}#buy`);
}

export async function startGiftCardCheckout(formData: FormData) {
  // Honeypot: real visitors never see or fill this field.
  if (String(formData.get("hp_note") ?? "").trim()) redirect("/gift-cards/thanks");
  if (await isActionRateLimited("gift-card")) back("Too many tries. Please wait a few minutes and try again.");

  const settings = await getGiftCardSettings();
  if (!settings.installed || !settings.enabled) redirect("/gift-cards");
  const db = supabaseAdmin();

  const designId = String(formData.get("design_id") ?? "");
  if (!UUID.test(designId)) back("Please pick a card design.");
  const { data: design, error: designError } = await db
    .from("gift_card_designs")
    .select("id, active, image_key")
    .eq("id", designId)
    .maybeSingle();
  if (designError) throw designError;
  if (!design || !design.active || !design.image_key) back("Please pick a card design.");

  const option = String(formData.get("option") ?? "");
  let choice: Choice;
  let session: OfferedSession | null = null;
  if (option.startsWith("preset:")) {
    choice = { kind: "preset", cents: Number(option.slice(7)) };
  } else if (option === "custom") {
    choice = { kind: "custom", dollars: String(formData.get("custom_dollars") ?? "") };
  } else if (option.startsWith("session:") && UUID.test(option.slice(8))) {
    choice = { kind: "session", sessionTypeId: option.slice(8) };
    const { data, error } = await db
      .from("session_types")
      .select("id, name, price_cents, currency, active, gift_card_offered")
      .eq("id", choice.sessionTypeId)
      .maybeSingle();
    if (error) throw error;
    session = (data as OfferedSession | null) ?? null;
  } else {
    back("Please pick an amount or a session.");
  }
  const priced = priceChoice(settings, choice, session);
  if (!priced.ok) back(priced.error);
  const p = priced.priced;

  const buyerName = text(formData, "buyer_name");
  const buyerEmail = text(formData, "buyer_email")?.toLowerCase() ?? null;
  const toName = text(formData, "to_name");
  const message = text(formData, "message");
  if (!buyerName || buyerName.length > 200) back("Please add your name.");
  if (!buyerEmail || buyerEmail.length > 200 || !EMAIL.test(buyerEmail)) back("Please add an email address. The code is sent there.");
  if (toName && toName.length > 60) back("The name on the card can be up to 60 characters.");
  if (message && message.length > 300) back("The message can be up to 300 characters.");

  const { data: purchase, error: insertError } = await db
    .from("gift_card_purchases")
    .insert({
      kind: p.kind,
      face_cents: p.faceCents,
      amount_cents: p.amountCents,
      currency: "usd",
      session_type_id: p.sessionTypeId,
      session_label: p.sessionLabel,
      design_id: designId,
      buyer_name: buyerName,
      buyer_email: buyerEmail,
      to_name: toName,
      message,
    })
    .select("id")
    .single();
  if (insertError || !purchase) throw insertError ?? new Error("Couldn't start the purchase");

  const baseUrl = env.appBaseUrl();
  const checkout = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: `Gift card: ${cardSummary(p.faceCents, p.sessionLabel)}` },
          unit_amount: p.amountCents,
        },
        quantity: 1,
      },
    ],
    customer_email: buyerEmail,
    client_reference_id: purchase.id,
    metadata: { kind: "gift_card", gift_card_purchase_id: purchase.id },
    payment_intent_data: { metadata: { kind: "gift_card", gift_card_purchase_id: purchase.id } },
    success_url: `${baseUrl}/gift-cards/thanks`,
    cancel_url: `${baseUrl}/gift-cards`,
  });
  if (!checkout.url) throw new Error("Stripe did not return a Checkout URL");

  const { error: updateError } = await db
    .from("gift_card_purchases")
    .update({ stripe_checkout_session_id: checkout.id })
    .eq("id", purchase.id);
  if (updateError) throw updateError;

  redirect(checkout.url);
}
