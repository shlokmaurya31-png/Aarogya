/**
 * Sliding-window rate limiter for inbound requests (login attempts, password
 * reset requests, paid AI calls).
 *
 * Two backends, chosen by configuration:
 *
 *   - Upstash Redis (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN set):
 *     one shared counter across every server instance. Required for a real
 *     limit on Vercel, where each serverless instance has its own memory.
 *   - In-process memory (default): correct for one long-running server and
 *     for local dev; on a multi-instance deployment the effective ceiling is
 *     N × instances.
 *
 * If Redis is configured but unreachable, the call falls back to the
 * in-memory limiter rather than failing open entirely or locking everyone
 * out of sign-in.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Milliseconds until the oldest counted hit leaves the window (0 when allowed). */
  retryAfterMs: number;
}

// ── In-process backend ──────────────────────────────────────────────────────

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
 * In-memory check. Records one hit for `key` and reports whether it is within
 * `limit` per `windowMs`. A refused hit is NOT recorded, so a client that
 * backs off regains access as soon as the window slides.
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

/** Clears an in-memory key. */
export function clearRateLimit(key: string) {
  buckets.delete(key);
}

// ── Upstash Redis backend (REST, no client dependency) ──────────────────────

// Same semantics as checkRateLimit, atomically in Redis: a sorted set of hit
// timestamps per key. Refused hits are not recorded.
const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
if redis.call('ZCARD', key) >= limit then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, tonumber(oldest[2]) + window - now}
end
redis.call('ZADD', key, now, ARGV[4])
redis.call('PEXPIRE', key, window)
return {1, 0}
`;

function upstashConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ""), token } : null;
}

async function upstash(command: (string | number)[]): Promise<unknown> {
  const config = upstashConfig()!;
  const res = await fetch(config.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
    cache: "no-store",
    signal: AbortSignal.timeout(2000),
  });
  const data = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok || data.error) throw new Error(data.error ?? `Upstash HTTP ${res.status}`);
  return data.result;
}

function redisKey(key: string) {
  return `aarogya:rl:${key}`;
}

/**
 * Records one hit and reports whether it is within the limit, using the
 * shared Redis store when configured. Prefer this over checkRateLimit in
 * request handlers.
 */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  if (!upstashConfig()) return checkRateLimit(key, limit, windowMs);
  const now = Date.now();
  try {
    const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
    const [allowed, retryAfterMs] = (await upstash([
      "EVAL", SLIDING_WINDOW_LUA, 1, redisKey(key), now, windowMs, limit, member,
    ])) as [number, number];
    return { allowed: allowed === 1, retryAfterMs: Math.max(0, Number(retryAfterMs)) };
  } catch (err) {
    console.error("Rate limiter: Upstash unavailable, using in-memory fallback.", err);
    return checkRateLimit(key, limit, windowMs, now);
  }
}

/** Clears a key in whichever store is active, e.g. after a successful login. */
export async function resetRateLimit(key: string): Promise<void> {
  clearRateLimit(key);
  if (!upstashConfig()) return;
  try {
    await upstash(["DEL", redisKey(key)]);
  } catch (err) {
    console.error("Rate limiter: Upstash unavailable while clearing a key.", err);
  }
}

/** Best-effort client IP. Behind Vercel/most proxies the first X-Forwarded-For hop is the client. */
export function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}
