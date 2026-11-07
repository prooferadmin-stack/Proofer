"use server";

// Public gallery unlock — no Supabase session reaches this route. The slug is
// re-validated (bound args are client-controllable), the password is checked
// against the stored PBKDF2 hash, and only then is a signed httpOnly cookie
// scoped to this one collection set. Attempts are throttled per IP + gallery.
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { isRateLimited, isRateLimitedFor } from "@/lib/rate-limit";
import { pickedIds } from "@/lib/galleries/paid-downloads";
import {
  MAX_PASSWORD_LENGTH,
  UNLOCK_TTL_SECONDS,
  normalizePassword,
  signUnlockToken,
  unlockCookieName,
  verifyPassword,
} from "@/lib/galleries/access";
import { SLUG_PATTERN, accessSecret, resolveGalleryAccess, resolveVisitorEmail } from "@/lib/galleries/viewer-access";
import { VISITOR_TTL_SECONDS, normalizeEmail, signVisitorToken, visitorCookieName } from "@/lib/galleries/favorites";
import { isUuid } from "@/lib/galleries/download";
import { stripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { addLine, pricedCart, setLineQty } from "@/lib/store/cart";
import { loadCatalog, readCart, writeCart } from "@/lib/store/gallery-store";

export async function unlockGallery(slug: string, formData: FormData) {
  if (!SLUG_PATTERN.test(slug)) redirect("/");
  const target = `/g/${slug}`;

  const secret = accessSecret();
  if (!secret) redirect(`${target}?error=unavailable`);

  const { data: collection, error } = await supabaseAdmin()
    .from("collections")
    .select("id, status, visibility, password_hash, access_version")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw error;
  // The page itself decides what a missing/draft/non-password gallery shows.
  if (!collection || collection.status !== "published" || collection.visibility !== "password") redirect(target);
  if (!collection.password_hash) redirect(target);

  const h = await headers();
  const ip = h.get("cf-connecting-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (isRateLimited(`gallery-unlock:${collection.id}:${ip}`)) redirect(`${target}?error=limited`);

  const password = normalizePassword(String(formData.get("password") ?? "").slice(0, MAX_PASSWORD_LENGTH + 50));
  if (!password || !(await verifyPassword(password, collection.password_hash))) {
    redirect(`${target}?error=wrong`);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + UNLOCK_TTL_SECONDS;
  const token = await signUnlockToken(secret, {
    collectionId: collection.id,
    accessVersion: collection.access_version,
    expiresAt,
  });
  (await cookies()).set(unlockCookieName(collection.id), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: UNLOCK_TTL_SECONDS,
  });

  redirect(target);
}

// ----------------------------------------------------------------- favorites
// Phase 5.6. The visitor names themselves by email once per gallery; a signed
// httpOnly cookie remembers it. Every action re-runs the full gallery access
// check first, so the cookie alone never opens anything.

function clientIp(h: Headers): string {
  return h.get("cf-connecting-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function setFavoritesEmail(slug: string, returnTo: string, formData: FormData) {
  const result = await resolveGalleryAccess(slug);
  if (!result || result.access !== "granted") redirect(SLUG_PATTERN.test(slug) ? `/g/${slug}` : "/");
  const { collection } = result;
  // returnTo is only ever a set id or "favorites"; anything else is dropped.
  const back = `/g/${collection.slug}${isUuid(returnTo) || returnTo === "favorites" ? `?set=${returnTo}` : ""}`;
  const sep = back.includes("?") ? "&" : "?";

  const secret = accessSecret();
  if (!secret) redirect(`${back}${sep}fav=unavailable`);

  if (isRateLimited(`gallery-email:${collection.id}:${clientIp(await headers())}`)) {
    redirect(`${back}${sep}fav=limited`);
  }

  const email = normalizeEmail(String(formData.get("email") ?? "").slice(0, 300));
  if (!email) redirect(`${back}${sep}fav=bad-email`);

  const expiresAt = Math.floor(Date.now() / 1000) + VISITOR_TTL_SECONDS;
  const token = await signVisitorToken(secret, { collectionId: collection.id, email, expiresAt });
  (await cookies()).set(visitorCookieName(collection.id), token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: VISITOR_TTL_SECONDS,
  });

  redirect(back);
}

export async function clearFavoritesEmail(slug: string) {
  const result = await resolveGalleryAccess(slug);
  if (!result) redirect("/");
  (await cookies()).delete(visitorCookieName(result.collection.id));
  redirect(`/g/${result.collection.slug}`);
}

type ToggleResult = { ok: true; favorited: boolean } | { ok: false; error: string };

// Called from the grid. Returns errors instead of throwing so the heart can
// roll back its optimistic state and say why.
export async function toggleFavorite(slug: string, assetId: string): Promise<ToggleResult> {
  if (typeof assetId !== "string" || !isUuid(assetId)) return { ok: false, error: "Unknown photo" };

  const result = await resolveGalleryAccess(slug);
  if (!result || result.access !== "granted") return { ok: false, error: "This gallery isn't available" };
  const { collection } = result;

  const email = await resolveVisitorEmail(collection.id);
  if (!email) return { ok: false, error: "Enter your email to save favorites" };

  const db = supabaseAdmin();
  const { data: asset, error: assetErr } = await db
    .from("media_assets")
    .select("id")
    .eq("id", assetId)
    .eq("collection_id", collection.id)
    .eq("status", "uploaded")
    .maybeSingle();
  if (assetErr) throw assetErr;
  if (!asset) return { ok: false, error: "Unknown photo" };

  const { data: existing, error: findErr } = await db
    .from("favorites")
    .select("id")
    .eq("asset_id", asset.id)
    .eq("visitor_email", email)
    .maybeSingle();
  if (findErr) throw findErr;

  if (existing) {
    const { error } = await db.from("favorites").delete().eq("id", existing.id);
    if (error) throw error;
    return { ok: true, favorited: false };
  }

  const { error } = await db
    .from("favorites")
    .insert({ collection_id: collection.id, asset_id: asset.id, visitor_email: email });
  // unique_violation = a double click already added it; that's still "favorited".
  if (error && error.code !== "23505") throw error;
  return { ok: true, favorited: true };
}
// --------------------------------------------------------------------- store
// Phase 7.2. Every action re-runs the full gallery access check and the
// store switch first. The cart cookie holds ids and quantities only; checkout
// prices every line from the database and hands Stripe those prices.
// Recording the order is 7.3 (verified webhook only).

const SHOP = "shop";

async function shopGallery(slug: string) {
  const result = await resolveGalleryAccess(slug);
  if (!result || result.access !== "granted") redirect(SLUG_PATTERN.test(slug) ? `/g/${slug}` : "/");
  const { data, error } = await supabaseAdmin()
    .from("collections")
    .select("store_enabled")
    .eq("id", result.collection.id)
    .single();
  if (error) throw error;
  if (!data?.store_enabled) redirect(`/g/${result.collection.slug}`);
  return result.collection;
}

function item(formData: FormData): { productId: string; variantId: string | null } | null {
  const productId = String(formData.get("product_id") ?? "");
  const variantRaw = String(formData.get("variant_id") ?? "");
  if (!isUuid(productId)) return null;
  if (variantRaw && !isUuid(variantRaw)) return null;
  return { productId: productId.toLowerCase(), variantId: variantRaw ? variantRaw.toLowerCase() : null };
}

export async function addToCart(slug: string, formData: FormData) {
  const collection = await shopGallery(slug);
  const back = `/g/${collection.slug}?set=${SHOP}`;
  const it = item(formData);
  const qty = Number(formData.get("qty") ?? 1);
  if (!it || !(qty >= 1)) redirect(`${back}&cart=bad-item`);
  const { products, variants } = await loadCatalog(supabaseAdmin());
  // Only things that can actually be bought go in the cart.
  if (pricedCart([{ ...it, qty: 1 }], products, variants).length === 0) redirect(`${back}&cart=unavailable`);
  const ok = await writeCart(collection.id, addLine(await readCart(collection.id), it, qty));
  redirect(ok ? `${back}&cart=added` : `${back}&cart=off`);
}

export async function setCartQty(slug: string, formData: FormData) {
  const collection = await shopGallery(slug);
  const back = `/g/${collection.slug}?set=${SHOP}`;
  const it = item(formData);
  if (!it) redirect(back);
  await writeCart(collection.id, setLineQty(await readCart(collection.id), it, Number(formData.get("qty") ?? 0)));
  redirect(back);
}

export async function checkoutCart(slug: string) {
  const collection = await shopGallery(slug);
  const back = `/g/${collection.slug}?set=${SHOP}`;
  if (isRateLimited(`store-checkout:${collection.id}:${clientIp(await headers())}`)) redirect(`${back}&cart=limited`);

  const cart = await readCart(collection.id);
  const { products, variants } = await loadCatalog(supabaseAdmin());
  const lines = pricedCart(cart, products, variants);
  if (lines.length === 0) redirect(`${back}&cart=empty`);
  // One currency per Checkout session.
  if (new Set(lines.map((l) => l.currency)).size > 1) redirect(`${back}&cart=currency`);
  if (lines.some((l) => l.unitCents <= 0)) redirect(`${back}&cart=unavailable`);

  const base = env.appBaseUrl();
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: lines.map((l) => ({
      quantity: l.qty,
      price_data: {
        currency: l.currency,
        unit_amount: l.unitCents,
        product_data: {
          name: l.label ? `${l.name} (${l.label})` : l.name,
          metadata: { product_id: l.productId, variant_id: l.variantId ?? "" },
        },
      },
    })),
    ...(lines.some((l) => l.requiresShipping) ? { shipping_address_collection: { allowed_countries: ["US" as const] } } : {}),
    metadata: { kind: "store_order", collection_id: collection.id },
    success_url: `${base}/g/${collection.slug}/shop/paid`,
    cancel_url: `${base}${back}`,
  });
  if (!session.url) throw new Error("Stripe did not return a Checkout URL");
  // The cart stays until the order is recorded (7.3); a canceled Checkout
  // comes back to the same cart.
  redirect(session.url);
}

// Paid extra downloads (5.7). The visitor's picks are only a filter:
// start_download_purchase() (migration 0034) re-reads the gallery, grants the
// free ones first, and fixes the price and count. Checkout charges exactly
// that amount; only the verified webhook grants the bought photos.
export async function buyDownloads(slug: string, formData: FormData) {
  const result = await resolveGalleryAccess(slug);
  if (!result || result.access !== "granted") redirect(SLUG_PATTERN.test(slug) ? `/g/${slug}` : "/");
  const { collection } = result;
  const back = `/g/${collection.slug}`;

  const ip = clientIp(await headers());
  const WINDOW = 15 * 60 * 1000;
  const byIp = isRateLimitedFor(`dl-buy-ip:${ip}`, 10, WINDOW);
  const byGallery = isRateLimitedFor(`dl-buy-gallery:${collection.id}`, 40, WINDOW);
  if (byIp || byGallery) redirect(`${back}?buy=limited`);

  const visitor = await resolveVisitorEmail(collection.id);
  if (!visitor) redirect(`${back}?buy=need_email`);

  const all = formData.get("all") === "1";
  const ids = all ? [] : pickedIds(formData.getAll("asset"));
  if (!all && ids.length === 0) redirect(`${back}?buy=none`);

  const db = supabaseAdmin();
  const { data, error } = await db.rpc("start_download_purchase", {
    p_collection_id: collection.id,
    p_visitor_key: visitor,
    p_asset_ids: ids,
    p_all: all,
  });
  if (error) throw error;
  const r = data as { ok: boolean; reason?: string; free_granted?: number; purchase_id?: string | null; photo_count?: number; unit_cents?: number };
  if (!r.ok) redirect(`${back}?buy=${encodeURIComponent(r.reason ?? "unavailable")}`);
  if (!r.purchase_id) redirect(`${back}?buy=free&n=${Number(r.free_granted ?? 0)}`);

  const baseUrl = env.appBaseUrl();
  const free = Number(r.free_granted ?? 0);
  const checkout = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: `Extra downloads: ${collection.name}` },
          unit_amount: Number(r.unit_cents),
        },
        quantity: Number(r.photo_count),
      },
    ],
    customer_email: visitor,
    client_reference_id: r.purchase_id,
    metadata: { kind: "download_purchase", download_purchase_id: r.purchase_id },
    payment_intent_data: { metadata: { kind: "download_purchase", download_purchase_id: r.purchase_id } },
    success_url: `${baseUrl}${back}?buy=paid`,
    cancel_url: `${baseUrl}${back}?buy=cancelled${free > 0 ? `&n=${free}` : ""}`,
  });
  if (!checkout.url) throw new Error("Stripe did not return a Checkout URL");

  const { error: updateError } = await db
    .from("download_purchases")
    .update({ stripe_checkout_session_id: checkout.id })
    .eq("id", r.purchase_id)
    .eq("status", "pending")
    .is("stripe_checkout_session_id", null);
  if (updateError) throw updateError;

  redirect(checkout.url);
}
