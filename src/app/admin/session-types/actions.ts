"use server";

// Session type CRUD. Every action checks requireAdmin() first, then uses the
// service-role client directly.
// Validation here mirrors the DB check constraints in 0009_session_types.sql
// and the booking-rule columns from 0010_availability.sql,
// so David gets a readable error instead of a raw Postgres one.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth/require-admin";
import { dollarsToCents } from "../invoices/money";

function str(raw: FormDataEntryValue | null): string | null {
  const v = raw ? String(raw).trim() : "";
  return v.length > 0 ? v : null;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseDollars(raw: FormDataEntryValue | null, label: string): number | null {
  const v = str(raw);
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be a non-negative amount`);
  return dollarsToCents(n);
}

function parseMinutes(raw: FormDataEntryValue | null, label: string): number {
  const v = str(raw);
  if (v === null) return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${label} must be a whole number of minutes, 0 or more`);
  return n;
}

function sessionTypeFields(formData: FormData) {
  const name = str(formData.get("name"));
  if (!name) throw new Error("Name is required");

  const slug = slugify(str(formData.get("slug")) ?? name);
  if (!slug) throw new Error("Slug must contain at least one letter or number");

  const duration = Number(str(formData.get("duration_minutes")));
  if (!Number.isInteger(duration) || duration <= 0) {
    throw new Error("Duration must be a whole number of minutes greater than 0");
  }

  const priceCents = parseDollars(formData.get("price"), "Price") ?? 0;
  const depositCents = parseDollars(formData.get("deposit"), "Deposit");
  if (depositCents !== null && (depositCents === 0 || depositCents > priceCents)) {
    throw new Error("Deposit must be greater than 0 and no more than the price (leave blank to require full payment)");
  }

  const maxPerDayRaw = str(formData.get("max_bookings_per_day"));
  const maxPerDay = maxPerDayRaw === null ? null : Number(maxPerDayRaw);
  if (maxPerDay !== null && (!Number.isInteger(maxPerDay) || maxPerDay <= 0)) {
    throw new Error("Max bookings per day must be a whole number greater than 0 (leave blank for unlimited)");
  }

  return {
    name,
    slug,
    description: str(formData.get("description")),
    image_url: str(formData.get("image_url")),
    duration_minutes: duration,
    price_cents: priceCents,
    deposit_cents: depositCents,
    is_public: formData.get("is_public") === "on",
    active: formData.get("active") === "on",
    gift_card_offered: formData.get("gift_card_offered") === "on",
    contract_template_id: str(formData.get("contract_template_id")),
    questionnaire_template_id: str(formData.get("questionnaire_template_id")),
    min_notice_minutes: parseMinutes(formData.get("min_notice_minutes"), "Minimum notice"),
    buffer_before_minutes: parseMinutes(formData.get("buffer_before_minutes"), "Buffer before"),
    buffer_after_minutes: parseMinutes(formData.get("buffer_after_minutes"), "Buffer after"),
    max_bookings_per_day: maxPerDay,
  };
}

// Postgres unique_violation — the only constraint on this table that can
// collide is the slug.
function rethrow(error: { code?: string }, slug: string): never {
  if (error.code === "23505") throw new Error(`Slug "${slug}" is already used by another session type`);
  throw error;
}

export async function createSessionType(formData: FormData) {
  await requireAdmin();
  const fields = sessionTypeFields(formData);

  const db = supabaseAdmin();
  const { data, error } = await db.from("session_types").insert(fields).select("id").single();
  if (error) rethrow(error, fields.slug);

  revalidatePath("/admin/session-types");
  redirect(`/admin/session-types/${data.id}`);
}

export async function updateSessionType(id: string, formData: FormData) {
  await requireAdmin();
  const fields = sessionTypeFields(formData);

  const db = supabaseAdmin();
  const { error } = await db
    .from("session_types")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) rethrow(error, fields.slug);

  revalidatePath("/admin/session-types");
  revalidatePath(`/admin/session-types/${id}`);
  redirect(`/admin/session-types/${id}`);
}

export async function deleteSessionType(id: string) {
  await requireAdmin();
  const db = supabaseAdmin();
  const { error } = await db.from("session_types").delete().eq("id", id);
  if (error) throw error;

  revalidatePath("/admin/session-types");
  redirect("/admin/session-types");
}
