// Paid extra downloads (Phase 5.7). Pure helpers shared by the gallery page,
// the admin settings and their tests. The database (migration 0034) decides
// what is actually charged; these only shape input and what the page shows.

export const MIN_PRICE_CENTS = 100;
export const MAX_PRICE_CENTS = 50000;
export const MAX_PHOTOS_PER_PURCHASE = 500;

// "15", "15.00", "$15", "" -> cents or null (blank = buying off). Throws on
// anything else, so a typo never silently switches buying off.
export function parsePriceDollars(raw: string): number | null {
  const v = raw.trim().replace(/^\$/, "");
  if (v === "") return null;
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(v)) throw new Error("Price must be a dollar amount like 15 or 15.00");
  const [whole, frac = ""] = v.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (cents < MIN_PRICE_CENTS || cents > MAX_PRICE_CENTS) throw new Error("Price must be between $1 and $500 per photo");
  return cents;
}

// What the select bar shows: free ones first, the rest at the price.
export function quote(selected: number, freeLeft: number | null, unitCents: number) {
  const free = Math.max(0, Math.min(selected, freeLeft ?? 0));
  const paid = Math.max(0, selected - free);
  return { free, paid, totalCents: paid * unitCents };
}

// Why a gallery can't sell downloads, for David's settings page.
export const BLOCKER_TEXT: Record<string, string> = {
  not_published: "The gallery isn't published.",
  downloads_off: "Downloads are switched off.",
  no_limit: "There's no download limit, so there's nothing extra to sell.",
  no_price: "No price is set.",
  no_project: "The gallery isn't linked to a project (the purchase becomes an invoice on it).",
  no_contact: "The gallery's project has no client.",
};

// Ids from a form: uuids only, each once, capped.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function pickedIds(values: FormDataEntryValue[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const s = String(v).toLowerCase();
    if (UUID.test(s)) out.add(s);
    if (out.size >= MAX_PHOTOS_PER_PURCHASE + 50) break;
  }
  return [...out];
}
