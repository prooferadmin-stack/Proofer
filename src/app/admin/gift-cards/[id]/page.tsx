// One gift card (Phase 2.7): what was bought, for how much, and its ledger.
// Read-only in 2.7; refunds and applying to invoices come with 2.8.
import Link from "next/link";
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { formatDateTime } from "@/lib/dates";
import { formatCode } from "@/lib/gift-cards/codes";
import { cardAmount, cardDate, cardSummary } from "@/lib/gift-cards/display";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND: Record<string, string> = { issue: "Issued", redeem: "Used on invoice", reverse: "Undone", void: "Voided" };

export default async function GiftCardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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
