// Simple in-memory fixed-window rate limiter for public, unauthenticated endpoints.
// Cloudflare Workers isolates are ephemeral and not shared across edge locations,
// so this is a best-effort throttle rather than a hard guarantee — acceptable per
// the Phase 1 spec, which explicitly defers a durable (KV/table-backed) limiter
// until this proves insufficient.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const MAX_TRACKED_KEYS = 10_000;

const hits = new Map<string, { count: number; windowStart: number }>();

export function isRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = hits.get(key);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    hits.set(key, { count: 1, windowStart: now });
    return false;
  }

  entry.count += 1;

  if (hits.size > MAX_TRACKED_KEYS) {
    for (const [k, v] of hits) {
      if (now - v.windowStart > WINDOW_MS) hits.delete(k);
    }
  }

  return entry.count > MAX_PER_WINDOW;
}

// For public server actions: limits by scope (e.g. "pay:<invoice id>") plus the
// caller's IP, read from the request headers.
export async function isActionRateLimited(scope: string): Promise<boolean> {
  const { headers } = await import("next/headers");
  const h = await headers();
  const ip = h.get("cf-connecting-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return isRateLimited(`${scope}:${ip}`);
}

// A separate limiter with its own window and cap, for gift card codes on
// /pay (2.8): 5 tries per 15 minutes, counted per IP and per invoice.
const custom = new Map<string, { count: number; windowStart: number }>();

export function isRateLimitedFor(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const entry = custom.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    custom.set(key, { count: 1, windowStart: now });
    if (custom.size > MAX_TRACKED_KEYS) {
      for (const [k, v] of custom) if (now - v.windowStart > windowMs) custom.delete(k);
    }
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}
