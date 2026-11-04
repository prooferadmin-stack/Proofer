// Public invoice payment page — no auth, reached via a link David sends the
// client. Reads through supabaseAdmin() (service-role) same as /inquire in
// Phase 1.5: safe because this runs server-side only, never exposing the
// service-role key to the browser.
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { formatCents } from "@/app/admin/invoices/money";
import type { Invoice, InvoiceInstallment, InvoiceLineItem } from "@/app/admin/invoices/types";
import { formatDay } from "@/lib/dates";
import { formatSessionWhen } from "@/lib/booking/book";
import { applyGiftCard, createCheckoutSession } from "./actions";
import { creditFor, invoiceCredit, nextPayment, type CreditRow } from "@/lib/gift-cards/due";
import { isMissingTable } from "@/lib/db-errors";
import { BrandFooter, BrandHeader } from "@/app/_brand/brand-frame";

export const dynamic = "force-dynamic";

type InvoiceWithProject = Invoice & { projects: { title: string } | null };

const PAY_ERRORS: Record<string, string> = {
  hold_expired: "Sorry, the time you picked is no longer held for you. Please book again and pick a time.",
  booking_canceled: "This booking was canceled.",
  limited: "Too many attempts. Please wait a few minutes and try again.",
  gift_card: "That code didn't work. Check it and try again.",
};

export default async function PayInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; applied?: string }>;
}) {
  const { id } = await params;
  const { error: errorKey, applied } = await searchParams;

  const db = supabaseAdmin();
  const [{ data, error }, { data: items, error: itemsError }, { data: scheduleRows, error: scheduleError }] =
    await Promise.all([
      db.from("invoices").select("*, projects(title)").eq("id", id).single(),
      db.from("invoice_line_items").select("*").eq("invoice_id", id).order("position", { ascending: true }),
      db.from("invoice_installments").select("*").eq("invoice_id", id).order("position", { ascending: true }),
    ]);
  if (error || !data) notFound();
  if (itemsError) throw itemsError;
  // Missing table = migration 0023 not run here yet: no schedules exist.
  if (scheduleError && !isMissingTable(scheduleError)) throw scheduleError;
  const installments = (scheduleRows ?? []) as InvoiceInstallment[];

  // Online booking behind this invoice, if any (4.4).
  const { data: booking, error: bookingError } = await db
    .from("bookings")
    .select("status, starts_at, timezone, hold_expires_at, session_types(name, slug)")
    .eq("invoice_id", id)
    .maybeSingle();
  if (bookingError && !isMissingTable(bookingError)) throw bookingError;
  const bookingType = booking?.session_types as unknown as { name: string; slug: string } | null;
  const holdLapsed =
    booking?.status === "pending_payment" && new Date(booking.hold_expires_at as string).getTime() <= Date.now();
  const bookingBlocksPay = booking?.status === "canceled" || holdLapsed;
  // Gift card credit (2.8): redemptions and undos on this invoice.
  const { data: creditRows, error: creditError } = await db
    .from("gift_card_ledger")
    .select("id, kind, amount_cents, invoice_id, installment_id, created_at, gift_cards(code)")
    .eq("invoice_id", id)
    .order("created_at", { ascending: true });
  if (creditError && !isMissingTable(creditError)) throw creditError;
  const credits = (creditRows ?? []) as unknown as (CreditRow & { id: string; gift_cards: { code: string } | null })[];
  const liveCards = new Map<string, number>();
  for (const c of credits) {
    const tail = c.gift_cards?.code.slice(-4) ?? "????";
    // Redemptions are negative and undos positive, so this nets to live credit.
    if (c.kind === "redeem" || c.kind === "reverse") liveCards.set(tail, (liveCards.get(tail) ?? 0) - c.amount_cents);
  }
  const totalCredit = invoiceCredit(credits, id);
  const pay = nextPayment({ id, total_cents: Number(data?.total_cents ?? 0) }, installments, credits);
  const next = pay?.installmentId ? (installments.find((i) => i.id === pay.installmentId) ?? null) : null;
  const appliedCents = applied && /^\d{1,9}$/.test(applied) ? Number(applied) : null;

  const invoice = data as unknown as InvoiceWithProject;
  const lineItems = (items ?? []) as InvoiceLineItem[];
  const payNow = createCheckoutSession.bind(null, invoice.id);

  return (
    <main>
      <BrandHeader />
      <h1>{invoice.projects?.title ?? "Invoice"}</h1>
      {errorKey && PAY_ERRORS[errorKey] && <p className="err">{PAY_ERRORS[errorKey]}</p>}
      {booking && bookingType && (
        <p>
          {bookingType.name}: <strong>{formatSessionWhen(new Date(booking.starts_at as string), booking.timezone as string)}</strong>
          {booking.status === "confirmed" && " (booked)"}
          {booking.status === "pending_payment" && !holdLapsed && ". This time is held for you while you pay."}
        </p>
      )}
      {holdLapsed && bookingType && (
        <p className="err">
          The hold on this time has run out. <a href={`/book/${bookingType.slug}`}>Pick a time again</a>.
        </p>
      )}

      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th>Qty</th>
            <th>Unit price</th>
            <th>Line total</th>
          </tr>
        </thead>
        <tbody>
          {lineItems.map((item) => (
            <tr key={item.id}>
              <td>{item.description}</td>
              <td>{item.quantity}</td>
              <td>{formatCents(item.unit_price_cents, invoice.currency)}</td>
              <td>{formatCents(Math.round(item.quantity * item.unit_price_cents), invoice.currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table>
        <tbody>
          <tr>
            <td>Subtotal</td>
            <td>{formatCents(invoice.subtotal_cents, invoice.currency)}</td>
          </tr>
          <tr>
            <td>Discount</td>
            <td>-{formatCents(invoice.discount_cents, invoice.currency)}</td>
          </tr>
          <tr>
            <td>Tax</td>
            <td>{formatCents(invoice.tax_cents, invoice.currency)}</td>
          </tr>
          <tr>
            <td>
              <strong>Total</strong>
            </td>
            <td>
              <strong>{formatCents(invoice.total_cents, invoice.currency)}</strong>
            </td>
          </tr>
          {[...liveCards.entries()]
            .filter(([, cents]) => cents > 0)
            .map(([tail, cents]) => (
              <tr key={tail}>
                <td>Gift card ending {tail}</td>
                <td>-{formatCents(cents, invoice.currency)}</td>
              </tr>
            ))}
          {totalCredit > 0 && invoice.status === "sent" && (
            <tr>
              <td>
                <strong>Left to pay</strong>
              </td>
              <td>
                <strong>{formatCents(Math.max(0, invoice.total_cents - totalCredit), invoice.currency)}</strong>
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {installments.length > 0 && (
        <>
          <h2>Payment schedule</h2>
          <table>
            <thead>
              <tr>
                <th>Payment</th>
                <th>Due</th>
                <th>Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {installments.map((i) => (
                <tr key={i.id}>
                  <td>{i.label}</td>
                  <td>{i.due_date ? formatDay(i.due_date) : "On receipt"}</td>
                  <td>
                    {formatCents(i.amount_cents, invoice.currency)}
                    {i.status !== "paid" && creditFor(credits, id, i.id) > 0 && (
                      <span className="muted small"> ({formatCents(creditFor(credits, id, i.id), invoice.currency)} by gift card)</span>
                    )}
                  </td>
                  <td>{i.status === "paid" ? "Paid" : i.id === next?.id ? "Due next" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {invoice.status === "paid" && <p>This invoice has already been paid. Thank you.</p>}
      {invoice.status === "void" && <p>This invoice has been voided.</p>}
      {invoice.status === "draft" && <p>This invoice isn&apos;t ready to be paid yet.</p>}
      {appliedCents !== null && (
        <p className="notice" role="status">
          Your gift card took {formatCents(appliedCents, invoice.currency)} off.
          {invoice.status === "paid" ? " Nothing more is due." : ""}
        </p>
      )}
      {invoice.status === "sent" && !bookingBlocksPay && pay && (
        <form action={payNow}>
          <button type="submit">
            {next ? `Pay ${next.label.toLowerCase()}: ${formatCents(pay.dueCents, invoice.currency)}` : `Pay ${formatCents(pay.dueCents, invoice.currency)}`}
          </button>
        </form>
      )}
      {invoice.status === "sent" && !bookingBlocksPay && booking?.status !== "pending_payment" && (
        <form action={applyGiftCard.bind(null, invoice.id)} id="gift-card" className="row" style={{ marginTop: 16 }}>
          <label htmlFor="gc-code">Have a gift card?</label>
          <input id="gc-code" name="code" type="text" required maxLength={40} autoComplete="off" autoCapitalize="characters" placeholder="DMP-XXXX-XXXX-XXXX" />
          <button type="submit">Apply</button>
        </form>
      )}
      <BrandFooter />
    </main>
  );
}
