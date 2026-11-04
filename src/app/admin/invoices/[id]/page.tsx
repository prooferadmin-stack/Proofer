import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { deleteInvoice, updateInvoice, updateInvoiceStatus } from "../actions";
import { LineItemsEditor } from "../line-items-editor";
import { formatCents } from "../money";
import { businessTodayISO, formatDateTime, formatDay } from "@/lib/dates";
import type { Invoice, InvoiceInstallment, InvoiceLineItem, PaymentEvent, PaymentOutcome } from "../types";
import { ClientLink } from "@/app/admin/_components/client-link";
import { ConfirmButton } from "@/app/admin/_components/confirm-button";
import { isMissingTable } from "@/lib/db-errors";
import { applyInvoiceGiftCard, previewInvoiceGiftCard, undoInvoiceGiftCard } from "../gift-card-actions";
import { REDEEM_REFUSALS, invoiceCredit, invoiceDue, type CreditRow } from "@/lib/gift-cards/due";
import { formatCode } from "@/lib/gift-cards/codes";

export const dynamic = "force-dynamic";

// Outcomes where money reached Stripe but the invoice couldn't take it.
const NEEDS_ATTENTION: Partial<Record<PaymentOutcome, string>> = {
  already_paid: "Paid again after this invoice was already paid. Refund the extra payment in Stripe.",
  not_payable:
    "A payment arrived that this invoice couldn't take (it wasn't sent, or the payment didn't match its schedule). Check it in Stripe.",
  amount_mismatch: "Stripe's amount didn't match this invoice's total, so it wasn't marked paid. Check it in Stripe.",
};

type InvoiceWithRelations = Invoice & {
  projects: { id: string; title: string } | null;
  contacts: { id: string; name: string } | null;
};

const UNDO: Record<string, string> = {
  undone: "Gift card payment undone; the amount is back on the card.",
  target_paid: "That part is already paid, so the gift card payment can't be undone.",
  already_undone: "That gift card payment was already undone.",
  not_found: "Couldn't find that gift card payment.",
  card_void: "That card is void.",
};

type GiftSearch = { gc?: string; gc_error?: string; gc_applied?: string; gc_undo?: string };

export default async function InvoiceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<GiftSearch>;
}) {
  const { id } = await params;
  const gift = await searchParams;

  const db = supabaseAdmin();
  const [
    { data, error },
    { data: items, error: itemsError },
    { data: eventRows, error: eventsError },
    { data: scheduleRows, error: scheduleError },
  ] = await Promise.all([
      db.from("invoices").select("*, projects(id, title), contacts(id, name)").eq("id", id).single(),
      db.from("invoice_line_items").select("*").eq("invoice_id", id).order("position", { ascending: true }),
      db
        .from("payment_events")
        .select("id, stripe_event_id, type, livemode, amount_cents, currency, outcome, received_at")
        .eq("invoice_id", id)
        .order("received_at", { ascending: true }),
      db.from("invoice_installments").select("*").eq("invoice_id", id).order("position", { ascending: true }),
    ]);
  if (error || !data) notFound();
  if (itemsError) throw itemsError;
  // Missing table = migration 0022 not run on this environment yet: no payment history.
  if (eventsError && !isMissingTable(eventsError)) throw eventsError;
  if (scheduleError && !isMissingTable(scheduleError)) throw scheduleError;
  const events = (eventRows ?? []) as PaymentEvent[];
  const installments = (scheduleRows ?? []) as InvoiceInstallment[];
  const partlyPaid = installments.some((i) => i.status === "paid");
  const alerts = events.filter((e) => NEEDS_ATTENTION[e.outcome]);

  const invoice = data as unknown as InvoiceWithRelations;
  const lineItems = (items ?? []) as InvoiceLineItem[];

  // Gift card payments on this invoice (2.8).
  const { data: creditRows, error: creditError } = await db
    .from("gift_card_ledger")
    .select("id, kind, amount_cents, invoice_id, installment_id, actor, created_at, reverses_ledger_id, gift_card_id, gift_cards(code)")
    .eq("invoice_id", id)
    .order("created_at", { ascending: true });
  if (creditError && !isMissingTable(creditError)) throw creditError;
  type GiftRow = CreditRow & { id: string; actor: string; created_at: string; reverses_ledger_id: string | null; gift_card_id: string; gift_cards: { code: string } | null };
  const giftRows = (creditRows ?? []) as unknown as GiftRow[];
  const reversed = new Set(giftRows.map((r) => r.reverses_ledger_id).filter(Boolean));
  const redemptions = giftRows.filter((r) => r.kind === "redeem");
  const giftCredit = invoiceCredit(giftRows, id);
  const due = invoiceDue(invoice, installments, giftRows);
  let preview: { code: string; balance: number; status: string; expired: boolean } | null = null;
  if (gift.gc && /^DMP[0-9A-Z]{12}$/.test(gift.gc)) {
    const { data: card } = await db.from("gift_cards").select("code, balance_cents, status, expires_at").eq("code", gift.gc).maybeSingle();
    preview = card
      ? { code: card.code as string, balance: Number(card.balance_cents), status: String(card.status), expired: new Date(String(card.expires_at)).getTime() < Date.now() }
      : null;
  }
  const giftError = gift.gc_error ? (REDEEM_REFUSALS[gift.gc_error] ?? "That didn't work.") : gift.gc && !preview ? REDEEM_REFUSALS.not_found : null;

  // Any payment freezes the invoice (enforced in the database too, 0022/0023,
  // and gift card credit since 0033).
  const editable = invoice.status !== "paid" && !partlyPaid && giftCredit === 0;

  const updateThisInvoice = updateInvoice.bind(null, invoice.id);
  const deleteThisInvoice = deleteInvoice.bind(null, invoice.id, invoice.project_id);
  const markSent = updateInvoiceStatus.bind(null, invoice.id, "sent");
  const markDraft = updateInvoiceStatus.bind(null, invoice.id, "draft");
  const markVoid = updateInvoiceStatus.bind(null, invoice.id, "void");

  const overdue = invoice.status === "sent" && invoice.due_date !== null && invoice.due_date < businessTodayISO();
  const [tone, statusLabel] =
    invoice.status === "paid" ? ["green", "Paid"] : invoice.status === "void" ? ["grey", "Void"] : invoice.status === "draft" ? ["blue", "Draft"] : overdue || alerts.length > 0 ? ["red", overdue ? "Overdue" : "Unpaid"] : ["blue", "Unpaid"];

  return (
    <main className="fluid workspace">
      {invoice.projects ? (
        <Link className="back" href={`/admin/projects/${invoice.projects.id}`}>
          ← {invoice.projects.title}
        </Link>
      ) : (
        <Link className="back" href="/admin/invoices">
          ← Invoices
        </Link>
      )}
      <header className="ws-head">
        <h1>Invoice · {formatCents(invoice.total_cents, invoice.currency)}</h1>
        <div className="ws-meta">
          <span className={`st ${tone}`}>{statusLabel}</span>
          {invoice.contacts && <span>{invoice.contacts.name}</span>}
          <span>{invoice.due_date ? `Due ${formatDay(invoice.due_date)}` : "Due on receipt"}</span>
        </div>
      </header>

      {alerts.map((e) => (
        <p key={e.id} className="notice err">
          <strong>Needs attention:</strong> {NEEDS_ATTENTION[e.outcome]} (Stripe event {e.stripe_event_id})
        </p>
      ))}

      <div className="ws">
        <aside className="ws-side" aria-label="Summary">
          <dl className="ws-facts">
            <div>
              <dt>Client</dt>
              <dd>{invoice.contacts ? <Link href={`/admin/contacts/${invoice.contacts.id}`}>{invoice.contacts.name}</Link> : "None"}</dd>
            </div>
            <div>
              <dt>Total</dt>
              <dd className="num">{formatCents(invoice.total_cents, invoice.currency)}</dd>
            </div>
            {giftCredit > 0 && (
              <div>
                <dt>Gift cards</dt>
                <dd className="num">-{formatCents(giftCredit, invoice.currency)}</dd>
              </div>
            )}
            {invoice.status === "sent" && giftCredit > 0 && (
              <div>
                <dt>Left to pay</dt>
                <dd className="num">{formatCents(due, invoice.currency)}</dd>
              </div>
            )}
            {invoice.status === "paid" && invoice.paid_at && (
              <div>
                <dt>Paid</dt>
                <dd className="num">
                  {formatCents(invoice.amount_paid_cents ?? 0, invoice.currency)}
                  <span className="sub">{formatDateTime(invoice.paid_at)}</span>
                </dd>
              </div>
            )}
          </dl>
          {invoice.status === "sent" && (
            <div className="ws-next">
              <span className="lbl">Client pay link</span>
              <ClientLink path={`/pay/${invoice.id}`} />
            </div>
          )}
          {editable && (
            <div className="ws-next">
              <span className="lbl">Status</span>
              <form action={invoice.status === "draft" ? markSent : markDraft}>
                <button type="submit" className={invoice.status === "draft" ? "primary" : undefined}>
                  {invoice.status === "draft" ? "Mark as sent and email client" : "Revert to draft"}
                </button>
              </form>
              {invoice.status !== "void" && (
                <form action={markVoid}>
                  <button type="submit" className="ghost">
                    Void invoice
                  </button>
                </form>
              )}
              <form action={deleteThisInvoice}>
                <ConfirmButton message="Delete this invoice? This can't be undone.">Delete invoice</ConfirmButton>
              </form>
            </div>
          )}
        </aside>

        <div className="ws-main">
          {editable ? (
            <section className="ws-sec">
              <h3>Line items</h3>
              <form action={updateThisInvoice}>
                <input type="hidden" name="project_id" value={invoice.project_id} />
                <input type="hidden" name="contact_id" value={invoice.contact_id} />
                <div>
                  <label htmlFor="due_date">Due date</label>
                  <input id="due_date" name="due_date" type="date" defaultValue={invoice.due_date ?? ""} />
                </div>
                <LineItemsEditor
                  items={lineItems}
                  schedule={installments}
                  discountType={invoice.discount_type}
                  discountValue={invoice.discount_value}
                  taxRate={invoice.tax_rate}
                />
                <div>
                  <label htmlFor="notes">Notes</label>
                  <textarea id="notes" name="notes" defaultValue={invoice.notes ?? ""} />
                </div>
                <button type="submit" className="primary">
                  Save changes
                </button>
              </form>
            </section>
          ) : (
            <section className="ws-sec">
              <h3>Line items</h3>
              <ul className="ws-rows">
                {lineItems.map((li) => (
                  <li key={li.id}>
                    <span className="grow">{li.description}</span>
                    <span className="muted small">
                      {li.quantity} × {formatCents(li.unit_price_cents, invoice.currency)}
                    </span>
                    <span className="small">{formatCents(Math.round(li.quantity * li.unit_price_cents), invoice.currency)}</span>
                  </li>
                ))}
              </ul>
              {invoice.notes && <p className="muted" style={{ marginTop: 12 }}>{invoice.notes}</p>}
            </section>
          )}

          {installments.length > 0 && !editable && (
            <section className="ws-sec">
              <h3>Payment schedule</h3>
              <ul className="ws-rows">
                {installments.map((i) => (
                  <li key={i.id}>
                    <span className={`st ${i.status === "paid" ? "green" : "blue"}`}>{i.status === "paid" ? "Paid" : "Unpaid"}</span>
                    <span className="grow">{i.label}</span>
                    <span className="muted small">{i.status === "paid" && i.paid_at ? formatDateTime(i.paid_at) : i.due_date ? `Due ${formatDay(i.due_date)}` : "On receipt"}</span>
                    <span className="small">{formatCents(i.amount_cents, invoice.currency)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(invoice.status === "sent" || redemptions.length > 0) && (
            <section className="ws-sec" id="gift-cards">
              <h3>Gift cards</h3>
              {giftError && <p className="notice err">{giftError}</p>}
              {gift.gc_applied && /^\d+$/.test(gift.gc_applied) && (
                <p className="notice">Applied {formatCents(Number(gift.gc_applied), invoice.currency)} from the gift card.</p>
              )}
              {gift.gc_undo && <p className={`notice${gift.gc_undo === "undone" ? "" : " err"}`}>{UNDO[gift.gc_undo] ?? "Couldn't undo that."}</p>}
              {redemptions.length > 0 && (
                <ul className="ws-rows">
                  {redemptions.map((r) => {
                    const target = r.installment_id ? installments.find((i) => i.id === r.installment_id) : null;
                    const open = invoice.status === "sent" && (!target || target.status === "unpaid");
                    return (
                      <li key={r.id}>
                        <span className={`st ${reversed.has(r.id) ? "grey" : "green"}`}>{reversed.has(r.id) ? "Undone" : "Applied"}</span>
                        <span className="grow">
                          <Link href={`/admin/gift-cards/${r.gift_card_id}`}>{r.gift_cards ? formatCode(r.gift_cards.code) : "Gift card"}</Link>
                          {target && <span className="muted small"> · {target.label}</span>}
                          <span className="muted small"> · by {r.actor === "admin" ? "you" : "client"}</span>
                        </span>
                        <span className="muted small">{formatDateTime(r.created_at)}</span>
                        <span className="small">{formatCents(-r.amount_cents, invoice.currency)}</span>
                        {!reversed.has(r.id) && open && (
                          <form action={undoInvoiceGiftCard.bind(null, invoice.id, r.id)}>
                            <button type="submit" className="ghost sm">
                              Undo
                            </button>
                          </form>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {invoice.status === "sent" &&
                (preview ? (
                  <div className="row">
                    <span>
                      {formatCode(preview.code)}: balance <strong>{formatCents(preview.balance, invoice.currency)}</strong>
                      {preview.status !== "active" ? " (void)" : preview.expired ? " (expired)" : ""}. Up to{" "}
                      {formatCents(Math.min(preview.balance, due), invoice.currency)} would go on this invoice.
                    </span>
                    <form action={applyInvoiceGiftCard.bind(null, invoice.id, preview.code)}>
                      <button type="submit" className="primary sm" disabled={preview.balance <= 0 || preview.status !== "active" || preview.expired || due <= 0}>
                        Apply
                      </button>
                    </form>
                    <Link href={`/admin/invoices/${invoice.id}#gift-cards`} className="btn ghost sm">
                      Cancel
                    </Link>
                  </div>
                ) : (
                  <form action={previewInvoiceGiftCard.bind(null, invoice.id)} className="row">
                    <input name="code" type="text" required maxLength={40} placeholder="DMP-XXXX-XXXX-XXXX" aria-label="Gift card code" autoComplete="off" />
                    <button type="submit">Check card</button>
                  </form>
                ))}
            </section>
          )}

          {events.length > 0 && (
            <section className="ws-sec">
              <h3>Payment history</h3>
              <ul className="ws-rows">
                {events.map((e) => (
                  <li key={e.id}>
                    <span className={`st ${e.outcome === "paid" || e.outcome === "installment_paid" ? "green" : NEEDS_ATTENTION[e.outcome] ? "red" : "grey"}`}>
                      {e.outcome.replace(/_/g, " ")}
                    </span>
                    <span className="grow">
                      {e.type}
                      {e.livemode ? "" : " (test)"}
                    </span>
                    <span className="muted small">{formatDateTime(e.received_at)}</span>
                    <span className="small">{e.amount_cents === null ? "" : formatCents(e.amount_cents, e.currency ?? invoice.currency)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
