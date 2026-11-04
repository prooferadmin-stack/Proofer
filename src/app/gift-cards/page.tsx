// Buy a gift card (Phase 2.7). Public and branded; a 404 while gift cards are
// switched off. A plain form posting to startGiftCardCheckout, which fixes the
// price on the server and opens Stripe Checkout. The prices shown here are
// for the buyer to read; the server recomputes every one.
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase";
import { BrandFooter, BrandHeader } from "@/app/_brand/brand-frame";
import { designImageUrl, getGiftCardDesigns, getGiftCardSettings } from "@/lib/gift-cards/settings";
import { sessionCardPrice } from "@/lib/gift-cards/pricing";
import { cardAmount } from "@/lib/gift-cards/display";
import { startGiftCardCheckout } from "./actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Gift cards" };

export default async function GiftCardsPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const settings = await getGiftCardSettings();
  if (!settings.installed || !settings.enabled) notFound();
  const designs = await getGiftCardDesigns(true);
  if (designs.length === 0) notFound();
  const images = await Promise.all(designs.map((d) => designImageUrl(d.image_key)));

  const { data: sessionRows, error: sessionError } = await supabaseAdmin()
    .from("session_types")
    .select("id, name, price_cents, currency")
    .eq("active", true)
    .eq("gift_card_offered", true)
    .gt("price_cents", 0)
    .order("name");
  if (sessionError) throw sessionError;
  const sessions = (sessionRows ?? []).filter((s) => String(s.currency).toLowerCase() === "usd");
  const pct = settings.sessionDiscountPercent;

  return (
    <main className="gc-buy">
      <BrandHeader />
      <h1>Gift cards</h1>
      <p>Give someone a session, or an amount toward one. The card comes to your email with a code and a printable card to hand over.</p>
      {error && (
        <p className="notice err" role="alert">
          {error.slice(0, 200)}
        </p>
      )}

      <form action={startGiftCardCheckout} id="buy">
        {/* Honeypot: hidden from real visitors. */}
        <div style={{ position: "absolute", left: "-9999px" }} aria-hidden="true">
          <label htmlFor="hp_note">Leave this empty</label>
          <input id="hp_note" name="hp_note" type="text" tabIndex={-1} autoComplete="new-password" />
        </div>

        <fieldset>
          <legend>Pick a design</legend>
          <div className="gc-designs">
            {designs.map((d, i) => (
              <label key={d.id} className="gc-design">
                <input type="radio" name="design_id" value={d.id} required defaultChecked={i === 0} />
                {images[i] ? <img src={images[i] as string} alt="" /> : <span className="gc-design-blank" aria-hidden="true" />}
                <span>{d.name}</span>
              </label>
            ))}
          </div>
        </fieldset>

        {sessions.length > 0 && (
          <fieldset>
            <legend>Give a session</legend>
            {pct > 0 && <p className="muted small">Session cards are {pct}% off: the card is worth the full session.</p>}
            {sessions.map((s) => (
              <label key={s.id} className="gc-option">
                <input type="radio" name="option" value={`session:${s.id}`} required />
                <span>
                  <strong>{s.name}</strong> · a {cardAmount(Number(s.price_cents))} card
                  {pct > 0 ? ` for ${cardAmount(sessionCardPrice(Number(s.price_cents), pct))}` : ""}
                </span>
              </label>
            ))}
          </fieldset>
        )}

        <fieldset>
          <legend>Or give an amount</legend>
          <div className="gc-presets">
            {settings.presetAmountsCents.map((c) => (
              <label key={c} className="gc-preset">
                <input type="radio" name="option" value={`preset:${c}`} required />
                <span>{cardAmount(c)}</span>
              </label>
            ))}
            <label className="gc-preset">
              <input type="radio" name="option" value="custom" required />
              <span>Other</span>
            </label>
          </div>
          <label htmlFor="custom_dollars">
            Other amount ({cardAmount(settings.customMinCents)} to {cardAmount(settings.customMaxCents)}, whole dollars)
          </label>
          <input
            id="custom_dollars"
            name="custom_dollars"
            type="number"
            inputMode="numeric"
            min={settings.customMinCents / 100}
            max={settings.customMaxCents / 100}
            step={1}
          />
        </fieldset>

        <fieldset>
          <legend>On the card (optional)</legend>
          <div>
            <label htmlFor="to_name">To</label>
            <input id="to_name" name="to_name" type="text" maxLength={60} />
          </div>
          <div>
            <label htmlFor="message">Message</label>
            <textarea id="message" name="message" maxLength={300} rows={3} />
          </div>
        </fieldset>

        <fieldset>
          <legend>Your details</legend>
          <div>
            <label htmlFor="buyer_name">Your name</label>
            <input id="buyer_name" name="buyer_name" type="text" required maxLength={200} autoComplete="name" />
          </div>
          <div>
            <label htmlFor="buyer_email">Your email (the code is sent here)</label>
            <input id="buyer_email" name="buyer_email" type="email" required maxLength={200} autoComplete="email" />
          </div>
        </fieldset>

        <p className="small muted gc-terms">{settings.terms}</p>
        <button type="submit" className="primary">
          Continue to payment
        </button>
      </form>
      <BrandFooter />
    </main>
  );
}
