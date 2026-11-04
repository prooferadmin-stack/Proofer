// How a gift card reads on the card, in emails and in admin (Phase 2.7).
// Pure, so Node's test runner can load it.

const BUSINESS_TIME_ZONE = "America/New_York";

// "$490" for whole dollars, "$12.50" otherwise.
export function cardAmount(cents: number): string {
  const whole = cents % 100 === 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: whole ? 0 : 2,
  }).format(cents / 100);
}

// What the card is worth, in words: "$250", or for a session card
// "$490 · Headshot Session at today's price" (David 2026-10-31, Q1).
export function cardSummary(valueCents: number, sessionLabel: string | null): string {
  return sessionLabel ? `${cardAmount(valueCents)} · ${sessionLabel} at today's price` : cardAmount(valueCents);
}

// "November 4, 2031": the expiry as a calendar date in David's time zone.
export function cardDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TIME_ZONE, month: "long", day: "numeric", year: "numeric" }).format(new Date(iso));
}
