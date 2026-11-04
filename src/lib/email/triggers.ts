// Event-triggered email (Phase 8.2). Each trigger loads what it needs, sends
// through sendTemplatedEmail with a per-event idempotency key, and never
// throws: an email problem must not undo the stage change, status change or
// send that fired it. Every outcome lands in email_log.
import { headers } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase";
import { env } from "@/lib/env";
import { ADMIN_EMAILS } from "@/lib/auth/admins";
import { businessTodayISO } from "@/lib/dates";
import { formatSessionWhen } from "@/lib/booking/book";
import { sendTemplatedEmail } from "./send";
import { isStageTemplate, isTemplateKey } from "./templates";
import { absoluteUrl, firstName, formatCents, formatDate, idempotencyKeys, projectFields } from "./events";
import { formatCode } from "@/lib/gift-cards/codes";
import { cardAmount, cardDate, cardSummary } from "@/lib/gift-cards/display";

// Links in emails need an absolute URL. APP_BASE_URL wins when set; otherwise
// use the host the admin is on (these triggers run in admin actions, or in the
// inquiry route whose emails carry no links).
export async function appBaseUrl(): Promise<string> {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL;
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host) {
      const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
      return `${proto}://${host}`;
    }
  } catch {
    // Outside a request (shouldn't happen for these triggers).
  }
  return env.appBaseUrl();
}

async function safely(label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    console.error(`email trigger failed: ${label}`, err);
  }
}

type ContactRow = { id: string; name: string | null; email: string | null };

async function loadContact(contactId: string | null): Promise<ContactRow | null> {
  if (!contactId) return null;
  const { data, error } = await supabaseAdmin()
    .from("contacts")
    .select("id, name, email")
    .eq("id", contactId)
    .maybeSingle();
  if (error) throw error;
  return (data as ContactRow | null) ?? null;
}

// A project just entered `stageId` (created there, dragged there, or edited
// there). Sends every active rule's template for that stage, once each.
export async function onStageEntered(projectId: string, stageId: string | null) {
  if (!stageId) return;
  await safely(`stage ${stageId} for project ${projectId}`, async () => {
    const db = supabaseAdmin();
    const { data: rules, error } = await db
      .from("automation_rules")
      .select("template_key")
      .eq("stage_id", stageId)
      .eq("active", true);
    if (error) throw error;
    if (!rules || rules.length === 0) return;

    const { data: project, error: projectErr } = await db
      .from("projects")
      .select("id, title, contact_id")
      .eq("id", projectId)
      .single();
    if (projectErr || !project) throw projectErr ?? new Error("Project not found");
    const contact = await loadContact(project.contact_id as string | null);
    if (!contact) return;

    for (const rule of rules) {
      const key = String(rule.template_key);
      // A rule pointing at a template that's gone or needs fields a project
      // can't fill is ignored rather than mailing a half-empty email.
      if (!isTemplateKey(key) || !isStageTemplate(key)) continue;
      await sendTemplatedEmail({
        key,
        to: contact.email ?? "",
        fields: projectFields(contact.name, project.title as string),
        contactId: contact.id,
        projectId: project.id as string,
        idempotencyKey: idempotencyKeys.stageEntered(project.id as string, stageId, key),
      });
    }
  });
}

// An invoice was marked sent: email the pay link.
export async function onInvoiceSent(invoiceId: string) {
  await safely(`invoice ${invoiceId}`, async () => {
    const { data: invoice, error } = await supabaseAdmin()
      .from("invoices")
      .select("id, contact_id, project_id, total_cents, due_date, status")
      .eq("id", invoiceId)
      .single();
    if (error || !invoice) throw error ?? new Error("Invoice not found");
    if (invoice.status !== "sent") return;
    const contact = await loadContact(invoice.contact_id as string | null);
    if (!contact) return;

    const base = await appBaseUrl();
    await sendTemplatedEmail({
      key: "invoice_sent",
      to: contact.email ?? "",
      fields: {
        ...projectFields(contact.name, null),
        "invoice.amount": formatCents(Number(invoice.total_cents)),
        "invoice.due_date": formatDate(invoice.due_date as string | null) || "on receipt",
        "invoice.link": absoluteUrl(base, `/pay/${invoice.id}`),
      },
      contactId: contact.id,
      projectId: (invoice.project_id as string | null) ?? null,
      idempotencyKey: idempotencyKeys.invoiceSent(invoice.id as string, Number(invoice.total_cents)),
    });
  });
}

// A verified Stripe payment was applied to an invoice (2.3 webhook): email
// the client a receipt for the amount that just came through.
export async function onPaymentReceived(stripeEventId: string, invoiceId: string, amountCents: number) {
  await safely(`payment ${stripeEventId}`, async () => {
    const { data: invoice, error } = await supabaseAdmin()
      .from("invoices")
      .select("id, contact_id, project_id")
      .eq("id", invoiceId)
      .single();
    if (error || !invoice) throw error ?? new Error("Invoice not found");
    const contact = await loadContact(invoice.contact_id as string | null);
    if (!contact) return;

    const base = await appBaseUrl();
    await sendTemplatedEmail({
      key: "payment_receipt",
      to: contact.email ?? "",
      fields: {
        ...projectFields(contact.name, null),
        "payment.amount": formatCents(amountCents),
        "payment.date": formatDate(businessTodayISO()),
        "invoice.link": absoluteUrl(base, `/pay/${invoice.id}`),
      },
      contactId: contact.id,
      projectId: (invoice.project_id as string | null) ?? null,
      idempotencyKey: idempotencyKeys.paymentReceipt(stripeEventId),
    });
  });
}

// An online booking was paid for and confirmed (4.4).
export async function onBookingConfirmed(bookingId: string) {
  await safely(`booking ${bookingId}`, async () => {
    const { data: b, error } = await supabaseAdmin()
      .from("bookings")
      .select("id, contact_id, project_id, starts_at, timezone, status, session_types(name), projects(title, location)")
      .eq("id", bookingId)
      .single();
    if (error || !b) throw error ?? new Error("Booking not found");
    if (b.status !== "confirmed") return;
    const contact = await loadContact(b.contact_id as string | null);
    if (!contact) return;
    const type = b.session_types as unknown as { name: string } | null;
    const project = b.projects as unknown as { title: string | null; location: string | null } | null;

    await sendTemplatedEmail({
      key: "booking_confirmation",
      to: contact.email ?? "",
      fields: {
        ...projectFields(contact.name, project?.title ?? null),
        "session.name": type?.name ?? "your session",
        "session.when": formatSessionWhen(new Date(b.starts_at as string), b.timezone as string),
        "session.location": project?.location ?? "",
      },
      contactId: contact.id,
      projectId: (b.project_id as string | null) ?? null,
      idempotencyKey: idempotencyKeys.bookingConfirmed(b.id as string),
    });
  });
}

// A quote was marked sent: email the link to pick a package.
export async function onQuoteSent(quoteId: string) {
  await safely(`quote ${quoteId}`, async () => {
    const { data: quote, error } = await supabaseAdmin()
      .from("quotes")
      .select("id, title, project_id, contact_id, status")
      .eq("id", quoteId)
      .single();
    if (error || !quote) throw error ?? new Error("Quote not found");
    if (quote.status !== "sent") return;
    const contact = await loadContact(quote.contact_id as string | null);
    if (!contact) return;

    const base = await appBaseUrl();
    await sendTemplatedEmail({
      key: "quote_sent",
      to: contact.email ?? "",
      fields: {
        ...projectFields(contact.name, null),
        "quote.title": String(quote.title ?? ""),
        "quote.link": absoluteUrl(base, `/quote/${quote.id}`),
      },
      contactId: contact.id,
      projectId: quote.project_id as string,
      idempotencyKey: idempotencyKeys.quoteSent(quote.id as string),
    });
  });
}

// A questionnaire was created for a project: email the fill-in link.
export async function onQuestionnaireSent(questionnaireId: string) {
  await safely(`questionnaire ${questionnaireId}`, async () => {
    const db = supabaseAdmin();
    const { data: q, error } = await db
      .from("questionnaires")
      .select("id, project_id, contact_id")
      .eq("id", questionnaireId)
      .single();
    if (error || !q) throw error ?? new Error("Questionnaire not found");
    const { data: project, error: projectErr } = await db
      .from("projects")
      .select("title")
      .eq("id", q.project_id)
      .single();
    if (projectErr || !project) throw projectErr ?? new Error("Project not found");
    const contact = await loadContact(q.contact_id as string | null);
    if (!contact) return;

    const base = await appBaseUrl();
    await sendTemplatedEmail({
      key: "questionnaire_sent",
      to: contact.email ?? "",
      fields: {
        ...projectFields(contact.name, project.title as string),
        "questionnaire.link": absoluteUrl(base, `/questionnaire/${q.id}`),
      },
      contactId: contact.id,
      projectId: q.project_id as string,
      idempotencyKey: idempotencyKeys.questionnaireSent(q.id as string),
    });
  });
}

type ContractRow = { id: string; status: string; contact_id: string; project_id: string; projects: { title: string } | null };

async function loadContract(contractId: string): Promise<ContractRow> {
  const { data, error } = await supabaseAdmin()
    .from("contracts")
    .select("id, status, contact_id, project_id, projects(title)")
    .eq("id", contractId)
    .single();
  if (error || !data) throw error ?? new Error("Contract not found");
  return data as unknown as ContractRow;
}

// A contract was sent for signature (Phase 3.3): email the signing link.
export async function onContractSent(contractId: string) {
  await safely(`contract sent ${contractId}`, async () => {
    const contract = await loadContract(contractId);
    if (contract.status !== "awaiting_signature") return;
    const contact = await loadContact(contract.contact_id);
    if (!contact) return;

    const base = await appBaseUrl();
    await sendTemplatedEmail({
      key: "contract_sent",
      to: contact.email ?? "",
      fields: {
        ...projectFields(contact.name, contract.projects?.title),
        "contract.link": absoluteUrl(base, `/sign/${contract.id}`),
      },
      contactId: contact.id,
      projectId: contract.project_id,
      idempotencyKey: idempotencyKeys.contractSent(contract.id),
    });
  });
}

// A contract was signed (Phase 3.2): the client gets a link to their signed
// copy, and David gets a note pointing at the admin record. Each send is
// guarded separately so one failing doesn't stop the other.
export async function onContractSigned(contractId: string) {
  let c: ContractRow;
  let who: ContactRow | null;
  let base: string;
  try {
    c = await loadContract(contractId);
    who = await loadContact(c.contact_id);
    base = await appBaseUrl();
  } catch (err) {
    console.error(`email trigger failed: contract signed ${contractId}`, err);
    return;
  }
  if (c.status !== "completed") return;
  const fields = projectFields(who?.name, c.projects?.title);
  const contract = c;

  const client = who;
  if (client) {
    await safely(`contract signed ${contractId} (client)`, async () => {
      await sendTemplatedEmail({
        key: "contract_signed",
        to: client.email ?? "",
        fields: { ...fields, "contract.link": absoluteUrl(base, `/sign/${contract.id}`) },
        contactId: client.id,
        projectId: contract.project_id,
        idempotencyKey: idempotencyKeys.contractSigned(contract.id),
      });
    });
  }
  await safely(`contract signed ${contractId} (David)`, async () => {
    await sendTemplatedEmail({
      key: "contract_signed_notice",
      to: ADMIN_EMAILS[0],
      fields: { ...fields, "contract.link": absoluteUrl(base, `/admin/contracts/${contract.id}`) },
      contactId: client?.id ?? null,
      projectId: contract.project_id,
      idempotencyKey: idempotencyKeys.contractSignedNotice(contract.id),
    });
  });
}

// A gift card was just issued by the webhook (2.7): the code and printable
// card link to the buyer, and a note to David. The code goes only to the
// buyer's email; the card link carries a separate token, never the code.
export async function onGiftCardIssued(stripeEventId: string, purchaseId: string) {
  const db = supabaseAdmin();
  const { data: card, error } = await db
    .from("gift_cards")
    .select("id, code, initial_cents, session_label, buyer_name, buyer_email, expires_at, view_token, gift_card_purchases(amount_cents)")
    .eq("purchase_id", purchaseId)
    .maybeSingle();
  if (error || !card) {
    console.error(`email trigger failed: gift card ${stripeEventId}`, error ?? "card not found");
    return;
  }
  const { data: settings } = await db.from("gift_card_settings").select("terms").eq("id", 1).maybeSingle();
  const purchase = card.gift_card_purchases as unknown as { amount_cents: number } | null;
  const base = await appBaseUrl();
  const summary = cardSummary(Number(card.initial_cents), (card.session_label as string | null) ?? null);

  await safely(`gift card ${card.id} (buyer)`, async () => {
    await sendTemplatedEmail({
      key: "gift_card_purchased",
      to: String(card.buyer_email ?? ""),
      fields: {
        "buyer.first_name": firstName(card.buyer_name as string | null),
        "card.summary": summary,
        "card.code": formatCode(String(card.code)),
        "card.expires": cardDate(String(card.expires_at)),
        "card.terms": (settings?.terms as string | undefined) ?? "",
        "card.link": absoluteUrl(base, `/gift-cards/card/${card.view_token}`),
      },
      idempotencyKey: idempotencyKeys.giftCardPurchased(card.id as string),
    });
  });
  await safely(`gift card ${card.id} (David)`, async () => {
    await sendTemplatedEmail({
      key: "gift_card_sold_notice",
      to: ADMIN_EMAILS[0],
      fields: {
        "buyer.name": String(card.buyer_name ?? ""),
        "buyer.email": String(card.buyer_email ?? ""),
        "card.summary": summary,
        "card.paid": purchase ? cardAmount(Number(purchase.amount_cents)) : "",
        "card.admin_link": absoluteUrl(base, `/admin/gift-cards/${card.id}`),
      },
      idempotencyKey: idempotencyKeys.giftCardSoldNotice(card.id as string),
    });
  });
}
