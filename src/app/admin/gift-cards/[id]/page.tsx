// One gift card (Phase 2.7): what was bought, for how much, and its ledger.
// 2.8: refund + void while unused and under 30 days old.
import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { formatDateTime } from "@/lib/dates";
import { formatCode } from "@/lib/gift-cards/codes";
import { cardAmount, cardDate, cardSummary } from "@/lib/gift-cards/display";
import { ConfirmButton } from "../../_components/confirm-button";
import { refundGiftCard } from "../actions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND: Record<string, string> = { issue: "Issued", redeem: "Used on invoice", reverse: "Undone", void: "Voided" };
const REFUND: Record<string, [string, boolean]> = {
  done: ["Refunded in Stripe and the card is void.", true],
  failed: ["The card is void but Stripe's refund failed. Retry below.", false],
  used: ["This card has been used, so it can't be refunded.", false],
  too_late: ["This card is more than 30 days old, so it can't be refunded.", false],
  already_void: ["This card was already void.", false],
};

export default async function GiftCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ refund?: string }>;
}) {
  const { id } = await params;
  const { refund } = await searchParams;
  if (!UUID.test(id)) notFound();
  const db = supabaseAdmin();
  const { data: card, error } = await db
    .from("gift_cards")
    .select("*, gift_card_purchases(*), gift_card_designs(name)")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!card) notFound();
  const { data: ledger, error: ledgerError } = await db
    .from("gift_card_ledger")
    .select("id, kind, amount_cents, invoice_id, actor, note, created_at")
    .eq("gift_card_id", id)
    .order("created_at");
  if (ledgerError) throw ledgerError;
  const rows = ledger ?? [];
  const sum = rows.reduce((n, r) => n + Number(r.amount_cents), 0);
  const purchase = card.gift_card_purchases as Record<string, unknown> | null;
  const design = card.gift_card_designs as { name: string } | null;
  const refundNote = refund ? REFUND[refund] : undefined;
  const used = rows.some((r) => r.kind === "redeem");
  const refundable =
    card.status === "active" && !used && Number(card.balance_cents) === Number(card.initial_cents) &&
    new Date(card.issued_at as string).getTime() > Date.now() - 30 * 86400_000;
  const refundStuck = card.status === "void" && purchase && !purchase.refund_id && !!purchase.refund_error;

  return (
    <main>
      <Link className="back" href="/admin/gift-cards">
        ← Gift cards
      </Link>
      <div className="pagehead">
        <h1>{formatCode(card.code as string)}</h1>
        <div className="row">
          <a className="btn" href={`/gift-cards/card/${card.view_token}`} target="_blank" rel="noreferrer">
            Printable card
          </a>
        </div>
      </div>

      <dl className="ph-money" style={{ margin: "var(--sp-4) 0" }}>
        <div>
          <dd>{cardAmount(Number(card.balance_cents))}</dd>
          <dt>balance</dt>
        </div>
        <div>
          <dd>{cardAmount(Number(card.initial_cents))}</dd>
          <dt>value</dt>
        </div>
        {purchase && (
          <div>
            <dd>{cardAmount(Number(purchase.amount_cents))}</dd>
            <dt>buyer paid</dt>
          </div>
        )}
      </dl>
      {refundNote && <p className={`notice${refundNote[1] ? "" : " err"}`}>{refundNote[0]}</p>}
      {refundable && (
        <form action={refundGiftCard.bind(null, id)} style={{ marginBottom: "var(--sp-4)" }}>
          <ConfirmButton message={`Void this card and refund the buyer ${purchase ? cardAmount(Number(purchase.amount_cents)) : ""} in Stripe? This can't be undone.`}>
            Refund and void
          </ConfirmButton>
          <span className="muted small"> Unused, bought under 30 days ago.</span>
        </form>
      )}
      {refundStuck && (
        <form action={refundGiftCard.bind(null, id)} style={{ marginBottom: "var(--sp-4)" }}>
          <p className="notice err">Stripe refund failed: {String(purchase!.refund_error)}</p>
          <button type="submit">Retry refund</button>
        </form>
      )}
      {sum !== Number(card.balance_cents) && (
        <p className="notice err">The ledger adds up to {cardAmount(sum)}, not the balance. Tell Claude before using this card.</p>
      )}

      <ul className="ws-rows">
        <li>
          <strong>Card</strong> {cardSummary(Number(card.initial_cents), card.session_label as string | null)}
          {design && <span className="muted"> · design {design.name}</span>}
        </li>
        <li>
          <strong>Buyer</strong> {card.buyer_name as string} · {card.buyer_email as string}
        </li>
        {(card.to_name || card.message) && (
          <li>
            <strong>On the card</strong> {card.to_name ? `To ${card.to_name}` : ""}
            {card.message ? <span className="muted"> · {card.message as string}</span> : null}
          </li>
        )}
        <li>
          <strong>Bought</strong> {formatDateTime(card.issued_at as string)} · <strong>Expires</strong> {cardDate(card.expires_at as string)}
        </li>
        <li>
          <strong>Status</strong> {card.status === "void" ? <span className="st red">Void</span> : <span className="st green">Active</span>}
          {card.void_reason ? <span className="muted"> · {card.void_reason as string}</span> : null}
        </li>
        {purchase && (
          <li className="small muted">
            Stripe Checkout {String(purchase.stripe_checkout_session_id ?? "")} · payment {String(purchase.stripe_payment_intent_id ?? "")}
            {purchase.refund_id ? ` · refunded ${formatDateTime(String(purchase.refunded_at))} (${String(purchase.refund_id)})` : ""}
          </li>
        )}
      </ul>

      <h2>Ledger</h2>
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>What</th>
            <th>Amount</th>
            <th>Invoice</th>
            <th>By</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id as string}>
              <td>{formatDateTime(r.created_at as string)}</td>
              <td>{KIND[r.kind as string] ?? String(r.kind)}</td>
              <td>{cardAmount(Number(r.amount_cents))}</td>
              <td>{r.invoice_id ? <Link href={`/admin/invoices/${r.invoice_id}`}>Open</Link> : "—"}</td>
              <td>{String(r.actor)}</td>
              <td className="muted">{(r.note as string | null) ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
