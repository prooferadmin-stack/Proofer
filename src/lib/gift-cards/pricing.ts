// What a gift card costs and what it's worth (Phase 2.7). Pure, so the rules
// can be tested; startGiftCardCheckout re-reads the settings and the session
// type's price from the database and passes them in. Nothing from the browser
// sets a price: the browser only says which option it picked.
//
// Session cards (David 2026-11-03): worth the session's price that day, sold
// at that price less the session discount (default 20%). Amount cards (a
// preset or a custom amount) sell at their value.

export type GiftCardSettings = {
  enabled: boolean;
  presetAmountsCents: number[];
  customMinCents: number;
  customMaxCents: number;
  sessionDiscountPercent: number;
  terms: string;
};

export const DEFAULT_SETTINGS: GiftCardSettings = {
  enabled: false,
  presetAmountsCents: [10000, 15000, 20000, 25000, 30000, 35000, 40000, 45000, 50000],
  customMinCents: 10000,
  customMaxCents: 200000,
  sessionDiscountPercent: 20,
  terms:
    "Good toward any David Monroe Photography invoice. Use it all at once or over several invoices; any balance stays on the card. Expires on the date shown, 5 years from purchase. No cash value. An unused card can be refunded within 30 days of purchase; once used, it can't be refunded.",
};

export type OfferedSession = { id: string; name: string; price_cents: number; currency: string; active: boolean; gift_card_offered: boolean };

export type Choice =
  | { kind: "preset"; cents: number }
  | { kind: "custom"; dollars: string }
  | { kind: "session"; sessionTypeId: string };

export type Priced = {
  kind: "amount" | "session";
  faceCents: number;
  amountCents: number;
  sessionTypeId: string | null;
  sessionLabel: string | null;
};

export type PriceResult = { ok: true; priced: Priced } | { ok: false; error: string };

// The session card price: value less the discount, rounded to the cent.
export function sessionCardPrice(valueCents: number, discountPercent: number): number {
  const pct = Math.min(50, Math.max(0, Math.trunc(discountPercent)));
  return Math.round((valueCents * (100 - pct)) / 100);
}

// "250" or "250.00" -> 25000. Whole dollars only; anything else is null.
export function parseWholeDollars(input: string): number | null {
  const m = /^\s*\$?\s*(\d{1,6})(?:\.0{1,2})?\s*$/.exec(input.replace(/,/g, ""));
  return m ? Number(m[1]) * 100 : null;
}

export function priceChoice(settings: GiftCardSettings, choice: Choice, session: OfferedSession | null): PriceResult {
  if (choice.kind === "preset") {
    if (!Number.isInteger(choice.cents) || !settings.presetAmountsCents.includes(choice.cents)) {
      return { ok: false, error: "Please pick one of the amounts shown." };
    }
    return { ok: true, priced: { kind: "amount", faceCents: choice.cents, amountCents: choice.cents, sessionTypeId: null, sessionLabel: null } };
  }
  if (choice.kind === "custom") {
    const cents = parseWholeDollars(choice.dollars);
    if (cents === null) return { ok: false, error: "Please enter a whole dollar amount." };
    if (cents < settings.customMinCents || cents > settings.customMaxCents) {
      return { ok: false, error: `Custom amounts go from $${settings.customMinCents / 100} to $${settings.customMaxCents / 100}.` };
    }
    return { ok: true, priced: { kind: "amount", faceCents: cents, amountCents: cents, sessionTypeId: null, sessionLabel: null } };
  }
  if (!session || session.id !== choice.sessionTypeId || !session.active || !session.gift_card_offered || session.price_cents <= 0) {
    return { ok: false, error: "That session isn't available as a gift card right now." };
  }
  if (session.currency.toLowerCase() !== "usd") return { ok: false, error: "That session isn't available as a gift card right now." };
  return {
    ok: true,
    priced: {
      kind: "session",
      faceCents: session.price_cents,
      amountCents: sessionCardPrice(session.price_cents, settings.sessionDiscountPercent),
      sessionTypeId: session.id,
      sessionLabel: session.name.trim().slice(0, 120),
    },
  };
}

// Admin-side checks for the settings form (mirrors the 0032 constraints).
export function validatePresets(cents: number[], customMinCents: number): string | null {
  if (cents.length > 12) return "Up to 12 preset amounts.";
  for (const c of cents) {
    if (!Number.isInteger(c) || c % 5000 !== 0 || c < 10000 || c > 1000000) return "Preset amounts go in $50 steps from $100 to $10,000.";
    if (c < customMinCents) return "Preset amounts can't be below the custom minimum.";
  }
  return null;
}
