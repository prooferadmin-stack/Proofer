"use server";

// Gift card setup (Phase 2.7): the on/off switch, amounts, session discount,
// terms and card designs, plus refunding an unused card (2.8). Nothing here
// creates or spends a card;
// cards come only from a paid Stripe purchase (issue_gift_card, 0032).
// Design images use the same presigned-PUT flow as product images, under
// gift-cards/designs/<design id>/<uuid>.<ext> (key shape enforced by 0032).
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth/require-admin";
import { deletePrefix, headObjectSize, presignPut, r2Configured } from "@/lib/r2";
import { parseWholeDollars, validatePresets } from "@/lib/gift-cards/pricing";

const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_BYTES = 15 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATH = "/admin/gift-cards/settings";

function dollars(formData: FormData, name: string, label: string): number {
  const cents = parseWholeDollars(String(formData.get(name) ?? ""));
  if (cents === null) throw new Error(`${label} must be a whole dollar amount`);
  return cents;
}

export async function updateGiftCardSettings(formData: FormData) {
  await requireAdmin();
  const customMin = dollars(formData, "custom_min", "Custom minimum");
  const customMax = dollars(formData, "custom_max", "Custom maximum");
  if (customMin < 10000) throw new Error("The custom minimum is at least $100");
  if (customMax < customMin) throw new Error("The custom maximum must be at least the minimum");
  if (customMax > 1000000) throw new Error("The custom maximum is at most $10,000");

  const presets = [
    ...new Set(
      String(formData.get("presets") ?? "")
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((v) => {
          const c = parseWholeDollars(v);
          if (c === null) throw new Error(`"${v}" isn't a whole dollar amount`);
          return c;
        })
    ),
  ].sort((a, b) => a - b);
  const presetError = validatePresets(presets, customMin);
  if (presetError) throw new Error(presetError);

  const pct = Number(String(formData.get("session_discount_percent") ?? "").trim());
  if (!Number.isInteger(pct) || pct < 0 || pct > 50) throw new Error("The session discount is a whole percent from 0 to 50");

  const terms = String(formData.get("terms") ?? "").trim();
  if (terms.length < 1 || terms.length > 2000) throw new Error("Terms are required (up to 2,000 characters)");

  const { error } = await supabaseAdmin().from("gift_card_settings").upsert({
    id: 1,
    preset_amounts_cents: presets,
    custom_min_cents: customMin,
    custom_max_cents: customMax,
    session_discount_percent: pct,
    terms,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
  revalidatePath(PATH);
}

export async function setGiftCardsEnabled(on: boolean) {
  await requireAdmin();
  const db = supabaseAdmin();
  if (on) {
    const { count, error } = await db
      .from("gift_card_designs")
      .select("id", { count: "exact", head: true })
      .eq("active", true)
      .not("image_key", "is", null);
    if (error) throw error;
    if (!count) throw new Error("Add at least one card design with a photo before switching gift cards on");
  }
  const { error } = await db.from("gift_card_settings").upsert({ id: 1, enabled: on, updated_at: new Date().toISOString() });
  if (error) throw error;
  revalidatePath(PATH);
  revalidatePath("/gift-cards");
}

export async function createGiftCardDesign(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim().slice(0, 80);
  if (!name) throw new Error("Give the design a name");
  const { error } = await supabaseAdmin().from("gift_card_designs").insert({ name });
  if (error) throw error;
  revalidatePath(PATH);
}

export async function renameGiftCardDesign(id: string, formData: FormData) {
  await requireAdmin();
  if (!UUID.test(id)) return;
  const name = String(formData.get("name") ?? "").trim().slice(0, 80);
  if (!name) throw new Error("Give the design a name");
  const { error } = await supabaseAdmin().from("gift_card_designs").update({ name }).eq("id", id);
  if (error) throw error;
  revalidatePath(PATH);
}

// Hiding a design keeps it on every card already bought with it.
export async function setGiftCardDesignActive(id: string, active: boolean) {
  await requireAdmin();
  if (!UUID.test(id)) return;
  const db = supabaseAdmin();
  if (!active) {
    const { data: settings } = await db.from("gift_card_settings").select("enabled").eq("id", 1).maybeSingle();
    const { count } = await db
      .from("gift_card_designs")
      .select("id", { count: "exact", head: true })
      .eq("active", true)
      .not("image_key", "is", null)
      .neq("id", id);
    if (settings?.enabled && !count) throw new Error("Switch gift cards off first, or add another design: the buy page needs one");
  }
  const { error } = await db.from("gift_card_designs").update({ active }).eq("id", id);
  if (error) throw error;
  revalidatePath(PATH);
}

export async function moveGiftCardDesign(id: string, direction: "up" | "down") {
  await requireAdmin();
  if (!UUID.test(id)) return;
  const db = supabaseAdmin();
  const { data, error } = await db.from("gift_card_designs").select("id, position").order("position");
  if (error) throw error;
  const rows = data ?? [];
  const i = rows.findIndex((r) => r.id === id);
  const j = direction === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= rows.length) return;
  const a = rows[i];
  const b = rows[j];
  const r1 = await db.from("gift_card_designs").update({ position: b.position }).eq("id", a.id);
  if (r1.error) throw r1.error;
  const r2 = await db.from("gift_card_designs").update({ position: a.position }).eq("id", b.id);
  if (r2.error) throw r2.error;
  revalidatePath(PATH);
}

// Only a design no purchase has used can be deleted (the database refuses
// otherwise); a used one can be hidden instead.
export async function deleteGiftCardDesign(id: string) {
  await requireAdmin();
  if (!UUID.test(id)) return;
  const db = supabaseAdmin();
  const { count, error: countError } = await db
    .from("gift_card_purchases")
    .select("id", { count: "exact", head: true })
    .eq("design_id", id);
  if (countError) throw countError;
  if (count) throw new Error("This design is on cards people bought, so it can only be hidden");
  const { data: settings } = await db.from("gift_card_settings").select("enabled").eq("id", 1).maybeSingle();
  if (settings?.enabled) {
    const { count: others } = await db
      .from("gift_card_designs")
      .select("id", { count: "exact", head: true })
      .eq("active", true)
      .not("image_key", "is", null)
      .neq("id", id);
    if (!others) throw new Error("Switch gift cards off first, or add another design: the buy page needs one");
  }
  const { error } = await db.from("gift_card_designs").delete().eq("id", id);
  if (error) throw error;
  await deletePrefix(`gift-cards/designs/${id}/`);
  revalidatePath(PATH);
}

type StartResult = { ok: true; url: string; key: string } | { ok: false; error: string };

export async function startGiftCardDesignUpload(designId: string, file: { type: string; size: number }): Promise<StartResult> {
  await requireAdmin();
  if (!UUID.test(designId)) return { ok: false, error: "Unknown design" };
  if (!r2Configured()) return { ok: false, error: "R2 isn't configured yet, uploads are disabled" };
  const ext = TYPES[file?.type];
  if (!ext) return { ok: false, error: "Use a JPEG, PNG or WebP image" };
  if (!(file.size > 0 && file.size <= MAX_BYTES)) return { ok: false, error: "Images can be up to 15 MB" };
  const key = `gift-cards/designs/${designId}/${crypto.randomUUID()}.${ext}`;
  return { ok: true, url: await presignPut(key, file.type), key };
}

export async function saveGiftCardDesignImage(designId: string, key: string): Promise<{ ok: boolean; error?: string }> {
  await requireAdmin();
  const prefix = `gift-cards/designs/${designId}/`;
  if (!UUID.test(designId) || typeof key !== "string" || !key.startsWith(prefix)) return { ok: false, error: "Bad image" };
  if ((await headObjectSize(key)) === null) return { ok: false, error: "The upload didn't arrive. Please try again." };
  const { error } = await supabaseAdmin().from("gift_card_designs").update({ image_key: key }).eq("id", designId);
  if (error) return { ok: false, error: error.message };
  // Older images for this design go. Cards bought with it show the new one,
  // which is the same design as far as the buyer is concerned.
  await deletePrefix(prefix, (k) => k !== key);
  revalidatePath(PATH);
  return { ok: true };
}

// Refund an unused card (2.8): void it first (void_gift_card, 0033: unused,
// active, under 30 days old), then refund the buyer in Stripe. If Stripe
// fails, the card stays void and this same action retries the refund; the
// idempotency key (the card id) means Stripe never refunds twice.
export async function refundGiftCard(cardId: string) {
  await requireAdmin();
  if (!UUID.test(cardId)) return;
  const db = supabaseAdmin();
  const { data: card, error } = await db
    .from("gift_cards")
    .select("id, status, purchase_id, gift_card_purchases(stripe_payment_intent_id, refund_id)")
    .eq("id", cardId)
    .maybeSingle();
  if (error) throw error;
  if (!card) return;
  const purchase = card.gift_card_purchases as unknown as { stripe_payment_intent_id: string | null; refund_id: string | null } | null;
  const back = (q: string) => redirect(`/admin/gift-cards/${cardId}?${q}`);

  if (card.status === "active") {
    const { data: outcome, error: voidError } = await db.rpc("void_gift_card", {
      p_card_id: cardId,
      p_reason: "Refunded to the buyer (unused, within 30 days)",
    });
    if (voidError) throw voidError;
    if (outcome !== "voided") back(`refund=${encodeURIComponent(String(outcome))}`);
  }
  if (purchase?.refund_id) back("refund=done");
  if (!purchase?.stripe_payment_intent_id) {
    await db.from("gift_card_purchases").update({ refund_error: "No Stripe payment on record" }).eq("id", card.purchase_id);
    back("refund=failed");
  }

  try {
    const { stripe } = await import("@/lib/stripe");
    const refund = await stripe().refunds.create(
      { payment_intent: purchase!.stripe_payment_intent_id!, metadata: { kind: "gift_card_refund", gift_card_id: cardId } },
      { idempotencyKey: `gift-card-refund:${cardId}` }
    );
    const { error: saveError } = await db
      .from("gift_card_purchases")
      .update({ refund_id: refund.id, refunded_at: new Date().toISOString(), refund_error: null })
      .eq("id", card.purchase_id);
    if (saveError) throw saveError;
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 300) : "Stripe refund failed";
    await db.from("gift_card_purchases").update({ refund_error: message }).eq("id", card.purchase_id);
    revalidatePath(`/admin/gift-cards/${cardId}`);
    back("refund=failed");
  }
  revalidatePath(`/admin/gift-cards/${cardId}`);
  revalidatePath("/admin/gift-cards");
  back("refund=done");
}
