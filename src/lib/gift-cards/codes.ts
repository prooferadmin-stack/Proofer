// Gift card codes (Phase 2.7). The database generates them
// (gift_card_random_code in migration 0032); this is how they're shown and
// how typed codes are matched. Pure, so Node's test runner can load it.

export const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const STORED = /^DMP[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{12}$/;

// "dmp-7k3q x9pa-..." -> "DMP7K3QX9PA..." Ignores case, spaces and dashes.
// Anything that can't be a code gives null, so a lookup never runs on it.
export function normalizeCode(input: string | null | undefined): string | null {
  const raw = String(input ?? "").toUpperCase().replace(/[\s-]+/g, "");
  if (raw.length > 40) return null;
  const withPrefix = raw.startsWith("DMP") ? raw : `DMP${raw}`;
  return STORED.test(withPrefix) ? withPrefix : null;
}

// "DMP7K3QX9PAM2RT" -> "DMP-7K3Q-X9PA-M2RT".
export function formatCode(stored: string): string {
  if (!STORED.test(stored)) return stored;
  const body = stored.slice(3);
  return `DMP-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}
