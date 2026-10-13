/**
 * In-process sliding-window rate limiter for inbound requests (login attempts,
 * paid AI calls).
 *
 * Same honesty caveat as the ABDM outbound limiter: state lives in this
 * process only, so the guarantee is "one server instance will not serve more
 * than N per window", not a global limit. On a multi-instance deployment the
 * effective ceiling is N × instances — still a hard bound on brute force and
 * spend, which is the point. Swap the Map for Redis/Upstash when a shared
 * store exists.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the oldest counted hit leaves the window (0 when allowed). */
  retryAfterMs: number;
}

const buckets = new Map<string, number[]>();
const MAX_KEYS = 10_000;

export function resetInboundRateLimiter() {
  buckets.clear();
}

/** Drops every bucket whose hits are all older than `windowMs`. Bounds memory. */
function prune(now: number, windowMs: number) {
  for (const [key, hits] of buckets) {
    if (hits.length === 0 || now - hits[hits.length - 1] >= windowMs) buckets.delete(key);
  }
}

/**
 * Records one hit for `key` and reports whether it is within `limit` per
 * `windowMs`. A refused hit is NOT recorded, so a client that backs off
 * regains access as soon as the window slides.
 */
export function checkRateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  if (buckets.size > MAX_KEYS) prune(now, windowMs);

  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    buckets.set(key, hits);
    return { allowed: false, retryAfterMs: windowMs - (now - hits[0]) };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { allowed: true, retryAfterMs: 0 };
}

/** Clears a key, e.g. after a successful login so earlier failures stop counting. */
export function clearRateLimit(key: string) {
  buckets.delete(key);
}

/** Best-effort client IP. Behind Vercel/most proxies the first X-Forwarded-For hop is the client. */
export function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}
