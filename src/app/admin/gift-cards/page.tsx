// Every gift card sold (Phase 2.7). Read-only: cards come only from paid
// Stripe purchases. Search by code, buyer name or email.
import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase";
import { isMissingTable } from "@/lib/db-errors";
import { formatDateTime } from "@/lib/dates";
import { formatCode, normalizeCode } from "@/lib/gift-cards/codes";
import { cardAmount, cardDate } from "@/lib/gift-cards/display";
import { getGiftCardSettings } from "@/lib/gift-cards/settings";

export const dynamic = "force-dynamic";

type Row = {
  id: string;
  code: string;
  buyer_name: string;
  buyer_email: string;
  initial_cents: number;
  balance_cents: number;
  session_label: string | null;
  issued_at: string;
  expires_at: string;
  status: string;
};

export default async function GiftCardsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q: rawQ } = await searchParams;
  const q = (rawQ ?? "").trim().slice(0, 100);
  const settings = await getGiftCardSettings();
  const db = supabaseAdmin();

  let query = db
    .from("gift_cards")
    .select("id, code, buyer_name, buyer_email, initial_cents, balance_cents, session_label, issued_at, expires_at, status")
    .order("issued_at", { ascending: false })
    .limit(200);
  if (q) {
    const code = normalizeCode(q);
    if (code) {
      query = query.eq("code", code);
    } else {
      // Commas and parentheses would break PostgREST's or() list; drop them.
      const term = q.replace(/[,()*%\\]/g, " ").trim();
      query = query.or(`buyer_name.ilike.*${term}*,buyer_email.ilike.*${term}*`);
    }
  }
  const { data, error } = await query;
  if (error && !isMissingTable(error)) throw error;
  const cards = (data ?? []) as Row[];

  const { data: openRows } = await db
    .from("gift_card_purchases")
    .select("id, buyer_name, face_cents, amount_cents, status, created_at")
    .neq("status", "paid")
    .gte("created_at", new Date(Date.now() - 30 * 86400_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(20);
  const open = openRows ?? [];
  const now = Date.now();

  return (
    <main>
      <div className="pagehead">
        <h1>Gift cards</h1>
        <div className="row">
          <Link href="/admin/gift-cards/settings" className="btn">
            Settings
          </Link>
        </div>
      </div>
      {!settings.installed ? (
        <p className="notice">Gift cards need migration 0032 on this database first.</p>
      ) : (
        <p className="muted small">
          Selling is {settings.enabled ? <span className="st green">on</span> : <span className="st">off</span>}. Cards are created only when
          a buyer&apos;s payment clears.
        </p>
      )}

      <form className="row" role="search">
        <input name="q" type="search" defaultValue={q} placeholder="Code, buyer name or email" aria-label="Search gift cards" />
        <button type="submit">Search</button>
      </form>

      {cards.length === 0 ? (
        <p className="muted">{q ? "No cards match." : "No gift cards sold yet."}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Buyer</th>
              <th>Value</th>
              <th>Balance</th>
              <th>Bought</th>
              <th>Expires</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c) => {
              const expired = new Date(c.expires_at).getTime() < now;
              return (
                <tr key={c.id}>
                  <td>
                    <Link href={`/admin/gift-cards/${c.id}`}>{formatCode(c.code)}</Link>
                  </td>
                  <td>
                    {c.buyer_name}
                    <span className="muted small"> · {c.buyer_email}</span>
                  </td>
                  <td>
                    {cardAmount(c.initial_cents)}
                    {c.session_label && <span className="muted small"> · {c.session_label}</span>}
                  </td>
                  <td>{cardAmount(c.balance_cents)}</td>
                  <td>{formatDateTime(c.issued_at)}</td>
                  <td>{cardDate(c.expires_at)}</td>
                  <td>
                    {c.status === "void" ? (
                      <span className="st red">Void</span>
                    ) : expired ? (
                      <span className="st amber">Expired</span>
                    ) : c.balance_cents === 0 ? (
                      <span className="st">Used up</span>
                    ) : (
                      <span className="st green">Active</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {open.length > 0 && (
        <>
          <h2>Unfinished checkouts (last 30 days)</h2>
          <p className="muted small">Started but not paid. No card exists for these.</p>
          <ul className="ws-rows">
            {open.map((p) => (
              <li key={p.id as string}>
                <span className="grow">
                  {p.buyer_name as string} · {cardAmount(Number(p.face_cents))}
                  {Number(p.amount_cents) !== Number(p.face_cents) && <span className="muted"> for {cardAmount(Number(p.amount_cents))}</span>}
                </span>
                <span className="st">{String(p.status)}</span>
                <span className="muted small">{formatDateTime(p.created_at as string)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
