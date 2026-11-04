// Gift card setup (Phase 2.7): what's for sale and how the cards look.
import Link from "next/link";
import { supabaseAdmin } from "@/lib/supabase";
import { designImageUrl, getGiftCardDesigns, getGiftCardSettings } from "@/lib/gift-cards/settings";
import { sessionCardPrice } from "@/lib/gift-cards/pricing";
import { cardAmount } from "@/lib/gift-cards/display";
import { ConfirmButton } from "../../_components/confirm-button";
import { DesignImageUpload } from "./design-upload";
import {
  createGiftCardDesign,
  deleteGiftCardDesign,
  moveGiftCardDesign,
  renameGiftCardDesign,
  setGiftCardDesignActive,
  setGiftCardsEnabled,
  updateGiftCardSettings,
} from "../actions";

export const dynamic = "force-dynamic";

export default async function GiftCardSettingsPage() {
  const settings = await getGiftCardSettings();
  if (!settings.installed) {
    return (
      <main>
        <h1>Gift card settings</h1>
        <p className="notice">Gift cards need migration 0032 on this database first.</p>
      </main>
    );
  }
  const designs = await getGiftCardDesigns(false);
  const images = await Promise.all(designs.map((d) => designImageUrl(d.image_key)));
  const usable = designs.filter((d) => d.active && d.image_key).length;
  const { data: sessionRows, error } = await supabaseAdmin()
    .from("session_types")
    .select("id, name, price_cents, active")
    .eq("gift_card_offered", true)
    .order("name");
  if (error) throw error;
  const sessions = sessionRows ?? [];

  return (
    <main>
      <Link className="back" href="/admin/gift-cards">
        ← Gift cards
      </Link>
      <div className="pagehead">
        <h1>Gift card settings</h1>
      </div>

      <h2 style={{ marginTop: 0 }}>Selling</h2>
      {settings.enabled ? (
        <p>
          <span className="st green">On</span> Clients can buy cards at <Link href="/gift-cards">/gift-cards</Link>.
        </p>
      ) : (
        <p>
          <span className="st">Off</span> The buy page shows nothing until you switch it on.
          {usable === 0 && <span className="muted small"> Add a design with a photo first.</span>}
        </p>
      )}
      <form action={setGiftCardsEnabled.bind(null, !settings.enabled)}>
        <button type="submit" className={settings.enabled ? "ghost sm" : "primary sm"} disabled={!settings.enabled && usable === 0}>
          {settings.enabled ? "Switch gift cards off" : "Switch gift cards on"}
        </button>
      </form>

      <h2>Amounts and price</h2>
      <form action={updateGiftCardSettings} className="brand-form">
        <div>
          <label htmlFor="presets">Amount buttons ($, in $50 steps)</label>
          <input id="presets" name="presets" type="text" defaultValue={settings.presetAmountsCents.map((c) => c / 100).join(", ")} />
        </div>
        <div>
          <label htmlFor="custom_min">Custom amount from ($)</label>
          <input id="custom_min" name="custom_min" type="number" min={100} step={1} required defaultValue={settings.customMinCents / 100} />
        </div>
        <div>
          <label htmlFor="custom_max">Custom amount up to ($)</label>
          <input id="custom_max" name="custom_max" type="number" min={100} max={10000} step={1} required defaultValue={settings.customMaxCents / 100} />
        </div>
        <div>
          <label htmlFor="session_discount_percent">Session card discount (%)</label>
          <input
            id="session_discount_percent"
            name="session_discount_percent"
            type="number"
            min={0}
            max={50}
            step={1}
            required
            defaultValue={settings.sessionDiscountPercent}
          />
          <p className="hint">The card is worth the full session; the buyer pays this much less. Amount cards always sell at their value.</p>
        </div>
        <div>
          <label htmlFor="terms">Terms (on the buy page and in the email)</label>
          <textarea id="terms" name="terms" rows={4} maxLength={2000} required defaultValue={settings.terms} />
        </div>
        <button type="submit" className="primary">
          Save
        </button>
      </form>

      <h2>Session cards</h2>
      {sessions.length === 0 ? (
        <p className="muted">
          None yet. Tick &quot;Sell as a gift card&quot; on a <Link href="/admin/session-types">session type</Link>.
        </p>
      ) : (
        <ul className="ws-rows">
          {sessions.map((s) => (
            <li key={s.id}>
              <span className="grow">
                <Link href={`/admin/session-types/${s.id}`}>{s.name}</Link>
                <span className="muted small">
                  {" "}
                  · a {cardAmount(Number(s.price_cents))} card for {cardAmount(sessionCardPrice(Number(s.price_cents), settings.sessionDiscountPercent))}
                  {!s.active && " · not offered while the session type is inactive"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      <h2>Designs</h2>
      <p className="muted">Your photos as card covers. The buyer picks one. Hidden designs stay on cards already bought.</p>
      <ul className="ws-rows brand-images">
        {designs.map((d, i) => (
          <li key={d.id}>
            <span className="brand-thumb">{images[i] ? <img src={images[i] as string} alt="" /> : <span aria-hidden="true" />}</span>
            <form action={renameGiftCardDesign.bind(null, d.id)} className="grow row">
              <input name="name" type="text" maxLength={80} required defaultValue={d.name} aria-label="Design name" />
              <button type="submit" className="ghost sm">
                Rename
              </button>
            </form>
            {!d.active && <span className="st">Hidden</span>}
            <DesignImageUpload designId={d.id} hasImage={!!d.image_key} />
            <form action={setGiftCardDesignActive.bind(null, d.id, !d.active)}>
              <button type="submit" className="ghost sm">
                {d.active ? "Hide" : "Show"}
              </button>
            </form>
            <form action={moveGiftCardDesign.bind(null, d.id, "up")}>
              <button type="submit" className="ghost sm" disabled={i === 0} aria-label="Move up">
                ↑
              </button>
            </form>
            <form action={moveGiftCardDesign.bind(null, d.id, "down")}>
              <button type="submit" className="ghost sm" disabled={i === designs.length - 1} aria-label="Move down">
                ↓
              </button>
            </form>
            <form action={deleteGiftCardDesign.bind(null, d.id)}>
              <ConfirmButton message={`Delete the design "${d.name}"?`}>
                Delete
              </ConfirmButton>
            </form>
          </li>
        ))}
      </ul>
      <form action={createGiftCardDesign} className="row">
        <input name="name" type="text" maxLength={80} required placeholder="Design name, e.g. Forsyth fountain" aria-label="New design name" />
        <button type="submit">Add design</button>
      </form>
    </main>
  );
}
