// One pass of the reminder queue (Phase 8.3), run hourly by the Worker's cron
// trigger (worker.mjs -> /api/cron/reminders) or by "Run now" on
// /admin/emails/reminders. Safe to run twice at once: jobs are claimed with a
// conditional update, and each send carries an idempotency key.
//
// Reads invoices, contracts and questionnaires; never writes to them. Only
// automation_jobs and email_log change here.
import { supabaseAdmin } from "@/lib/supabase";
import { isMissingTable } from "@/lib/db-errors";
import { creditFor } from "@/lib/gift-cards/due";
import { loadCredits } from "@/lib/gift-cards/redeem";
import { sendTemplatedEmail } from "@/lib/email/send";
import { isSendableEmail } from "@/lib/email/render";
import { absoluteUrl, formatCents, formatDate, idempotencyKeys, projectFields } from "@/lib/email/events";
import type { TemplateKey } from "@/lib/email/templates";
import {
  MAX_ATTEMPTS,
  STUCK_AFTER_MS,
  SETTING_FOR,
  installmentSteps,
  invoiceSteps,
  isStale,
  planReconcile,
  reminderTemplate,
  retryDelayMs,
  sentDocumentSteps,
  type DesiredJob,
  type ExistingJob,
  type ReminderKind,
  type ReminderSetting,
} from "./schedule";

export type RunSummary = {
  on: ReminderSetting[];
  queued: number;
  rescheduled: number;
  canceled: number;
  sent: number;
  skipped: number;
  failed: number;
  retrying: number;
  note?: string;
};

const BATCH = 25;

type ContactJoin = { name: string | null; email: string | null } | null;

function emailOf(contact: ContactJoin): string | null {
  const email = (contact?.email ?? "").trim().toLowerCase();
  return email && isSendableEmail(email) ? email : null;
}

export async function loadReminderSettings(): Promise<Record<ReminderSetting, boolean> | null> {
  const { data, error } = await supabaseAdmin().from("reminder_settings").select("kind, active");
  if (isMissingTable(error)) return null;
  if (error) throw error;
  const on = { invoice: false, contract: false, questionnaire: false };
  for (const row of data ?? []) {
    if (row.kind in on) on[row.kind as ReminderSetting] = Boolean(row.active);
  }
  return on;
}

// Invoice ids whose booking hold was never paid: an abandoned booking is a
// lead, not a debt, so it gets no payment reminders.
async function abandonedBookingInvoices(invoiceIds: string[]): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set();
  const { data, error } = await supabaseAdmin()
    .from("bookings")
    .select("invoice_id")
    .in("invoice_id", invoiceIds)
    .neq("status", "confirmed");
  if (isMissingTable(error)) return new Set();
  if (error) throw error;
  return new Set((data ?? []).map((b) => b.invoice_id as string));
}

async function desiredInvoiceJobs(): Promise<DesiredJob[]> {
  const db = supabaseAdmin();
  const { data: invoices, error } = await db
    .from("invoices")
    .select("id, due_date, contact_id, project_id, contacts(name, email)")
    .eq("status", "sent");
  if (error) throw error;
  const open = (invoices ?? []).filter((i) => emailOf(i.contacts as unknown as ContactJoin));
  const ids = open.map((i) => i.id as string);
  if (ids.length === 0) return [];

  const skip = await abandonedBookingInvoices(ids);
  const { data: installments, error: instErr } = await db
    .from("invoice_installments")
    .select("id, invoice_id, due_date, status")
    .in("invoice_id", ids);
  if (instErr && !isMissingTable(instErr)) throw instErr;
  const byInvoice = new Map<string, { id: string; due_date: string | null; status: string }[]>();
  for (const row of installments ?? []) {
    const list = byInvoice.get(row.invoice_id as string) ?? [];
    list.push({ id: row.id as string, due_date: row.due_date as string | null, status: row.status as string });
    byInvoice.set(row.invoice_id as string, list);
  }

  const jobs: DesiredJob[] = [];
  for (const inv of open) {
    const id = inv.id as string;
    if (skip.has(id)) continue;
    const owner = { contact_id: inv.contact_id as string | null, project_id: inv.project_id as string | null };
    const schedule = byInvoice.get(id);
    if (schedule && schedule.length > 0) {
      for (const inst of schedule) if (inst.status !== "paid") jobs.push(...installmentSteps(inst, owner));
    } else {
      jobs.push(...invoiceSteps({ id, due_date: inv.due_date as string | null, ...owner }));
    }
  }
  return jobs;
}

async function desiredContractJobs(): Promise<DesiredJob[]> {
  const { data, error } = await supabaseAdmin()
    .from("contracts")
    .select("id, sent_at, contact_id, project_id, contacts(name, email)")
    .eq("status", "awaiting_signature");
  if (error) throw error;
  return (data ?? [])
    .filter((c) => emailOf(c.contacts as unknown as ContactJoin))
    .flatMap((c) =>
      sentDocumentSteps("contract", {
        id: c.id as string,
        sent_at: c.sent_at as string | null,
        contact_id: c.contact_id as string | null,
        project_id: c.project_id as string | null,
      }),
    );
}

async function desiredQuestionnaireJobs(): Promise<DesiredJob[]> {
  // A questionnaire is sent the moment it's created.
  const { data, error } = await supabaseAdmin()
    .from("questionnaires")
    .select("id, created_at, contact_id, project_id, contacts(name, email)")
    .is("submitted_at", null);
  if (error) throw error;
  return (data ?? [])
    .filter((q) => emailOf(q.contacts as unknown as ContactJoin))
    .flatMap((q) =>
      sentDocumentSteps("questionnaire", {
        id: q.id as string,
        sent_at: q.created_at as string,
        contact_id: q.contact_id as string | null,
        project_id: q.project_id as string | null,
      }),
    );
}

type Outgoing = {
  key: TemplateKey;
  to: string;
  fields: Record<string, string>;
  contactId: string | null;
  projectId: string | null;
};

// The email for a job, built from the document as it is right now, or null
// if the document no longer needs chasing.
async function buildEmail(job: ExistingJob, baseUrl: string): Promise<Outgoing | null> {
  const db = supabaseAdmin();
  const key = reminderTemplate(job.kind, job.step);

  if (job.kind === "invoice" || job.kind === "installment") {
    let invoiceId = job.target_id;
    let amountCents: number;
    let dueDate: string | null;
    if (job.kind === "installment") {
      const { data: inst, error } = await db
        .from("invoice_installments")
        .select("invoice_id, amount_cents, due_date, status")
        .eq("id", job.target_id)
        .maybeSingle();
      if (error) throw error;
      if (!inst || inst.status !== "unpaid") return null;
      invoiceId = inst.invoice_id as string;
      amountCents = Number(inst.amount_cents);
      dueDate = inst.due_date as string | null;
    } else {
      amountCents = 0;
      dueDate = null;
    }
    const { data: inv, error } = await db
      .from("invoices")
      .select("id, status, total_cents, due_date, contact_id, project_id, contacts(name, email)")
      .eq("id", invoiceId)
      .maybeSingle();
    if (error) throw error;
    if (!inv || inv.status !== "sent") return null;
    if ((await abandonedBookingInvoices([invoiceId])).size > 0) return null;
    if (job.kind === "invoice") {
      // A schedule added since the job was queued takes over from it.
      const { count, error: countErr } = await db
        .from("invoice_installments")
        .select("id", { count: "exact", head: true })
        .eq("invoice_id", invoiceId);
      if (countErr && !isMissingTable(countErr)) throw countErr;
      if ((count ?? 0) > 0) return null;
      amountCents = Number(inv.total_cents);
      dueDate = inv.due_date as string | null;
    }
    // Gift card credit (2.8) comes off the amount in the reminder.
    const credits = await loadCredits(db, invoiceId);
    amountCents -= creditFor(credits, invoiceId, job.kind === "installment" ? job.target_id : null);
    if (amountCents <= 0) return null;
    const contact = inv.contacts as unknown as ContactJoin;
    const to = emailOf(contact);
    if (!to) return null;
    return {
      key,
      to,
      fields: {
        ...projectFields(contact?.name, null),
        "invoice.amount": formatCents(amountCents),
        "invoice.due_date": formatDate(dueDate) || "on receipt",
        "invoice.link": absoluteUrl(baseUrl, `/pay/${invoiceId}`),
      },
      contactId: inv.contact_id as string | null,
      projectId: inv.project_id as string | null,
    };
  }

  if (job.kind === "contract") {
    const { data: c, error } = await db
      .from("contracts")
      .select("id, status, contact_id, project_id, contacts(name, email), projects(title)")
      .eq("id", job.target_id)
      .maybeSingle();
    if (error) throw error;
    if (!c || c.status !== "awaiting_signature") return null;
    const contact = c.contacts as unknown as ContactJoin;
    const to = emailOf(contact);
    if (!to) return null;
    const project = c.projects as unknown as { title: string | null } | null;
    return {
      key,
      to,
      fields: {
        ...projectFields(contact?.name, project?.title),
        "contract.link": absoluteUrl(baseUrl, `/sign/${c.id}`),
      },
      contactId: c.contact_id as string | null,
      projectId: c.project_id as string | null,
    };
  }

  const { data: q, error } = await db
    .from("questionnaires")
    .select("id, submitted_at, contact_id, project_id, contacts(name, email), projects(title)")
    .eq("id", job.target_id)
    .maybeSingle();
  if (error) throw error;
  if (!q || q.submitted_at) return null;
  const contact = q.contacts as unknown as ContactJoin;
  const to = emailOf(contact);
  if (!to) return null;
  const project = q.projects as unknown as { title: string | null } | null;
  return {
    key,
    to,
    fields: {
      ...projectFields(contact?.name, project?.title),
      "questionnaire.link": absoluteUrl(baseUrl, `/questionnaire/${q.id}`),
    },
    contactId: q.contact_id as string | null,
    projectId: q.project_id as string | null,
  };
}

async function finish(id: string, patch: Record<string, unknown>) {
  const { error } = await supabaseAdmin()
    .from("automation_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function runReminders(opts: { baseUrl: string; now?: Date }): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const db = supabaseAdmin();
  const summary: RunSummary = { on: [], queued: 0, rescheduled: 0, canceled: 0, sent: 0, skipped: 0, failed: 0, retrying: 0 };

  const settings = await loadReminderSettings();
  if (!settings) return { ...summary, note: "Reminders aren't set up on this environment yet (migration 0026)." };
  summary.on = (Object.keys(settings) as ReminderSetting[]).filter((k) => settings[k]);

  // 1. Put back jobs a crashed run left mid-send. The idempotency key stops a
  //    reminder that did go out from going out again.
  const { error: stuckErr } = await db
    .from("automation_jobs")
    .update({ status: "scheduled", updated_at: now.toISOString() })
    .eq("status", "running")
    .lt("updated_at", new Date(now.getTime() - STUCK_AFTER_MS).toISOString());
  if (stuckErr) throw stuckErr;

  // 2. Reconcile the queue with what's open right now.
  const desired: DesiredJob[] = [
    ...(settings.invoice ? await desiredInvoiceJobs() : []),
    ...(settings.contract ? await desiredContractJobs() : []),
    ...(settings.questionnaire ? await desiredQuestionnaireJobs() : []),
  ];
  const { data: existing, error: existingErr } = await db
    .from("automation_jobs")
    .select("id, kind, target_id, step, run_at, status, attempts")
    .in("status", ["scheduled", "canceled"]);
  if (existingErr) throw existingErr;
  const plan = planReconcile(desired, (existing ?? []) as ExistingJob[], now);

  if (plan.insert.length > 0) {
    const { data: added, error } = await db
      .from("automation_jobs")
      .upsert(plan.insert, { onConflict: "kind,target_id,step", ignoreDuplicates: true })
      .select("id");
    if (error) throw error;
    summary.queued += (added ?? []).length;
  }
  for (const r of plan.revive) {
    await finish(r.id, { status: "scheduled", run_at: r.run_at, attempts: 0, last_error: null, finished_at: null });
    summary.queued++;
  }
  for (const r of plan.reschedule) {
    await finish(r.id, { run_at: r.run_at });
    summary.rescheduled++;
  }
  for (const c of plan.cancel) {
    await finish(c.id, { status: "canceled", last_error: c.reason, finished_at: now.toISOString() });
    summary.canceled++;
  }

  // 3. Send what's due.
  const { data: due, error: dueErr } = await db
    .from("automation_jobs")
    .select("id, kind, target_id, step, run_at, status, attempts")
    .eq("status", "scheduled")
    .lte("run_at", now.toISOString())
    .order("run_at", { ascending: true })
    .limit(BATCH);
  if (dueErr) throw dueErr;

  for (const job of (due ?? []) as ExistingJob[]) {
    // Reconcile already canceled switched-off kinds; never send one regardless.
    if (!settings[SETTING_FOR[job.kind as ReminderKind]]) continue;
    if (isStale(job.run_at, now)) {
      await finish(job.id, { status: "canceled", last_error: "Too late to send", finished_at: now.toISOString() });
      summary.canceled++;
      continue;
    }

    // Claim it. Another run that got here first wins; this one moves on.
    const attempts = job.attempts + 1;
    const { data: claimed, error: claimErr } = await db
      .from("automation_jobs")
      .update({ status: "running", attempts, updated_at: now.toISOString() })
      .eq("id", job.id)
      .eq("status", "scheduled")
      .select("id");
    if (claimErr) throw claimErr;
    if (!claimed || claimed.length === 0) continue;

    let email: Outgoing | null;
    try {
      email = await buildEmail(job, opts.baseUrl);
    } catch (err) {
      console.error(`reminder ${job.id}: couldn't load its document`, err);
      await finish(job.id, retryPatch(attempts, "Couldn't load the document", now));
      if (attempts >= MAX_ATTEMPTS) summary.failed++;
      else summary.retrying++;
      continue;
    }
    if (!email) {
      await finish(job.id, { status: "canceled", last_error: "Resolved before it was due", finished_at: now.toISOString() });
      summary.canceled++;
      continue;
    }

    const result = await sendTemplatedEmail({ ...email, idempotencyKey: idempotencyKeys.reminder(job.id) });
    if (result.status === "sent" || result.status === "duplicate") {
      await finish(job.id, { status: "sent", last_error: null, finished_at: now.toISOString() });
      summary.sent++;
    } else if (result.status === "skipped") {
      await finish(job.id, { status: "skipped", last_error: result.reason, finished_at: now.toISOString() });
      summary.skipped++;
    } else {
      await finish(job.id, retryPatch(attempts, result.error, now));
      if (attempts >= MAX_ATTEMPTS) summary.failed++;
      else summary.retrying++;
    }
  }

  return summary;
}

function retryPatch(attempts: number, error: string, now: Date): Record<string, unknown> {
  if (attempts >= MAX_ATTEMPTS) {
    return { status: "failed", last_error: error.slice(0, 1000), finished_at: now.toISOString() };
  }
  return {
    status: "scheduled",
    run_at: new Date(now.getTime() + retryDelayMs(attempts)).toISOString(),
    last_error: error.slice(0, 1000),
  };
}
