"use server";

// Booking changes David controls (Phase 4.4). Only cancel: confirming is the
// webhook's job and the database refuses anything else (migration 0024).
// Canceling frees the time; any refund is done in Stripe by hand.
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { requireAdmin } from "@/lib/auth/require-admin";
import { syncBookingQuietly } from "@/lib/gcal/client";
import { bookingRange, localDate } from "@/lib/booking/book";
import { loadLiveBookings } from "@/lib/booking/load";
import { zonedTimeToInstant } from "@/lib/booking/slots";
import { BUSINESS_TIME_ZONE } from "@/lib/dates";
import { onStageEntered } from "@/lib/email/triggers";
import { insertDraftInvoice } from "../invoices/draft";
import type { SessionType } from "../session-types/types";

export async function cancelBooking(id: string) {
  await requireAdmin();
  const { error } = await supabaseAdmin()
    .from("bookings")
    .update({ status: "canceled", canceled_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", ["pending_payment", "confirmed"]);
  if (error) throw error;
  // Off the Google Calendar too (4.5); the hourly job retries on failure.
  await syncBookingQuietly(id);
  revalidatePath("/admin/bookings");
}

const MAX_BOOKING_NOTES = 2000;

function bookingFailed(projectId: string, message: string): never {
  redirect(`/admin/projects/${projectId}?booking_error=${encodeURIComponent(message)}#sessions`);
}

// David adds a session by hand (phone, text, in person). It is confirmed on
// the spot, with no payment: the database only refuses a confirmed overlap
// (migration 0027's exclusion constraint), and this checks live bookings and
// holds first so he gets a readable message. His availability windows and
// notice rules are deliberately skipped, and so is his Google Calendar's busy
// time: he is choosing the time himself. The session goes onto Google
// Calendar like any other, and a DRAFT invoice is made from the session
// type's price for him to edit and send.
export async function createManualBooking(projectId: string, formData: FormData) {
  await requireAdmin();
  const db = supabaseAdmin();

  const sessionTypeId = String(formData.get("session_type_id") ?? "");
  const date = String(formData.get("date") ?? "").trim();
  const time = String(formData.get("time") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (notes && notes.length > MAX_BOOKING_NOTES) bookingFailed(projectId, "Notes are too long (2000 characters at most).");

  const [{ data: project, error: projectError }, { data: typeRow, error: typeError }] = await Promise.all([
    db.from("projects").select("id, contact_id, stage_id, title").eq("id", projectId).maybeSingle(),
    db.from("session_types").select("*").eq("id", sessionTypeId).eq("active", true).maybeSingle(),
  ]);
  if (projectError || typeError) throw projectError ?? typeError;
  if (!project) bookingFailed(projectId, "That project no longer exists.");
  if (!project.contact_id) bookingFailed(projectId, "Link a client to this project before adding a booking.");
  if (!typeRow) bookingFailed(projectId, "Pick a session type.");
  const type = typeRow as SessionType;

  const start = zonedTimeToInstant(date, time, BUSINESS_TIME_ZONE);
  if (!start) bookingFailed(projectId, "Enter a real date and time (a time skipped by a clock change isn't allowed).");

  const range = bookingRange(type, start);
  const clash = await loadLiveBookings(db, range.blockedFrom, range.blockedUntil);
  if (clash.length > 0) bookingFailed(projectId, "That time overlaps another booking (or a held slot). Pick another time.");

  const now = new Date().toISOString();
  const { data: booking, error: insertError } = await db
    .from("bookings")
    .insert({
      session_type_id: type.id,
      contact_id: project.contact_id,
      project_id: project.id,
      starts_at: range.start.toISOString(),
      ends_at: range.end.toISOString(),
      blocked_from: range.blockedFrom.toISOString(),
      blocked_until: range.blockedUntil.toISOString(),
      timezone: BUSINESS_TIME_ZONE,
      status: "confirmed",
      confirmed_at: now,
      // Not a payment hold; required by the table, already in the past.
      hold_expires_at: now,
      client_notes: notes,
    })
    .select("id")
    .single();
  // 23P01: the exclusion constraint caught an overlap that slipped in after the check.
  if (insertError?.code === "23P01") bookingFailed(projectId, "That time was just taken. Pick another time.");
  if (insertError || !booking) throw insertError ?? new Error("Booking insert failed");

  // Everything below is best effort: the booking itself is already saved.
  const problems: string[] = [];

  if (type.price_cents > 0) {
    try {
      const invoiceId = await insertDraftInvoice(
        db,
        { project_id: project.id, contact_id: project.contact_id, currency: type.currency, tax_rate: 0, notes: null },
        [{ description: type.name, quantity: 1, unit_price_cents: type.price_cents }]
      );
      const { error } = await db.from("bookings").update({ invoice_id: invoiceId }).eq("id", booking.id);
      if (error) throw error;
    } catch (err) {
      console.error("manual booking: draft invoice failed", booking.id, err);
      problems.push("the draft invoice couldn't be created");
    }
  }

  try {
    const [{ data: stages }, { error: dateError }] = await Promise.all([
      db.from("project_stages").select("id, name, position").order("position", { ascending: true }),
      db.from("projects").update({ event_date: localDate(range.start, BUSINESS_TIME_ZONE) }).eq("id", project.id),
    ]);
    if (dateError) throw dateError;
    // Booked means booked: move an earlier card to Booked, never a later one backwards.
    const booked = stages?.find((s) => String(s.name).toLowerCase() === "booked");
    const current = stages?.find((s) => s.id === project.stage_id);
    if (booked && booked.id !== project.stage_id && (!current || current.position < booked.position)) {
      const { error } = await db.from("projects").update({ stage_id: booked.id }).eq("id", project.id);
      if (error) throw error;
      await onStageEntered(project.id, booked.id);
    }
  } catch (err) {
    console.error("manual booking: project update failed", booking.id, err);
    problems.push("the project's date or stage couldn't be updated");
  }

  // Onto Google Calendar. Never throws; the hourly job retries.
  await syncBookingQuietly(booking.id);

  revalidatePath("/admin/bookings");
  revalidatePath(`/admin/projects/${project.id}`);
  if (problems.length > 0) bookingFailed(projectId, `Booking saved, but ${problems.join(" and ")}.`);
  redirect(`/admin/projects/${project.id}#sessions`);
}
