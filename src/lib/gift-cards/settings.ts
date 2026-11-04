// Loads gift card settings and designs (Phase 2.7). Before migration 0032 runs
// on an environment, gift cards read as switched off.
import { supabaseAdmin } from "@/lib/supabase";
import { isMissingTable } from "@/lib/db-errors";
import { presignGet, r2Configured } from "@/lib/r2";
import { DEFAULT_SETTINGS, type GiftCardSettings } from "./pricing";

export type GiftCardDesign = { id: string; name: string; image_key: string | null; active: boolean; position: number };

export async function getGiftCardSettings(): Promise<GiftCardSettings & { installed: boolean }> {
  const { data, error } = await supabaseAdmin().from("gift_card_settings").select("*").eq("id", 1).maybeSingle();
  if (isMissingTable(error)) return { ...DEFAULT_SETTINGS, installed: false };
  if (error) throw error;
  if (!data) return { ...DEFAULT_SETTINGS, installed: true };
  return {
    installed: true,
    enabled: data.enabled === true,
    presetAmountsCents: ((data.preset_amounts_cents as number[] | null) ?? []).map(Number).sort((a, b) => a - b),
    customMinCents: Number(data.custom_min_cents),
    customMaxCents: Number(data.custom_max_cents),
    sessionDiscountPercent: Number(data.session_discount_percent),
    terms: String(data.terms ?? DEFAULT_SETTINGS.terms),
  };
}

export async function getGiftCardDesigns(onlyActive: boolean): Promise<GiftCardDesign[]> {
  let q = supabaseAdmin().from("gift_card_designs").select("id, name, image_key, active, position").order("position");
  if (onlyActive) q = q.eq("active", true).not("image_key", "is", null);
  const { data, error } = await q;
  if (isMissingTable(error)) return [];
  if (error) throw error;
  return (data ?? []) as GiftCardDesign[];
}

export async function designImageUrl(key: string | null, seconds = 3600): Promise<string | null> {
  if (!key || !r2Configured()) return null;
  return presignGet(key, seconds);
}
