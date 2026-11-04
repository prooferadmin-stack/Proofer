// The printable gift card (2.7). Reached only by the random view token from
// the buyer's email, never by the code. Shows the card's current balance and
// status; not indexed.
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { isMissingTable } from "@/lib/db-errors";
import { getBrand } from "@/lib/brand/brand";
import { BrandAccent } from "@/app/_brand/brand-frame";
import { designImageUrl } from "@/lib/gift-cards/settings";
import { formatCode } from "@/lib/gift-cards/codes";
import { cardAmount, cardDate, cardSummary } from "@/lib/gift-cards/display";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";
export const metadata = { title: "Gift card", robots: { index: false, follow: false } };

const TOKEN = /^[0-9a-f]{64}$/;

export default async function GiftCardPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!TOKEN.test(token)) notFound();
  const { data: card, error } = await supabaseAdmin()
    .from("gift_cards")
    .select("code, initial_cents, balance_cents, session_label, to_name, message, expires_at, status, gift_card_designs(image_key)")
    .eq("view_token", token)
    .maybeSingle();
  if (isMissingTable(error)) notFound();
  if (error) throw error;
  if (!card) notFound();

  const brand = await getBrand();
  const design = card.gift_card_designs as unknown as { image_key: string | null } | null;
  const image = await designImageUrl(design?.image_key ?? null);
  const expired = new Date(String(card.expires_at)).getTime() < Date.now();
  const balance = Number(card.balance_cents);
  const initial = Number(card.initial_cents);

  return (
    <main className="gc-page">
      <BrandAccent />
      <article className="gc-card">
        {image && <img className="gc-card-image" src={image} alt="" />}
        <div className="gc-card-body">
          <p className="gc-card-brand">{brand.businessName}</p>
          <h1>Gift card</h1>
          <p className="gc-card-amount">{cardSummary(initial, (card.session_label as string | null) ?? null)}</p>
          {card.to_name && <p className="gc-card-to">For {card.to_name as string}</p>}
          {card.message && <p className="gc-card-message">{card.message as string}</p>}
          <p className="gc-card-code">{formatCode(String(card.code))}</p>
          <p className="small">Good until {cardDate(String(card.expires_at))}</p>
          <p className="small muted">Good toward any {brand.businessName} invoice. Enter the code when you pay. No cash value.</p>
        </div>
      </article>
      <div className="gc-status no-print">
        {card.status === "void" ? (
          <p className="notice err">This card is no longer valid.</p>
        ) : expired ? (
          <p className="notice err">This card has expired.</p>
        ) : (
          <p>
            Balance: <strong>{cardAmount(balance)}</strong>
            {balance < initial && <span className="muted"> of {cardAmount(initial)}</span>}
          </p>
        )}
        <PrintButton />
      </div>
    </main>
  );
}
