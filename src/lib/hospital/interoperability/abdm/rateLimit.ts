/**
 * Phase C3 — conservative outbound rate limiting.
 *
 * ABDM does not publish a rate limit in the Milestone 3 documentation. Rather
 * than assume none exists, this applies a deliberately cautious in-process
 * limiter: a shared national sandbox is infrastructure other integrators depend
 * on, and hammering it is both antisocial and the fastest way to get a bridge
 * suspended.
 *
 * In-process and per-operation on purpose. A distributed limiter would need
 * shared state this phase has no justification for, and the honest description
 * of what this provides is "this process will not burst", not "the deployment
 * is globally rate limited".
 */

export interface RateLimitConfig {
  /** Maximum requests allowed in the window. */
  limit: number;
  windowMs: number;
  /** Minimum gap between two consecutive calls of the same operation. */
  minIntervalMs: number;
}

/**
 * Conservative defaults. Session is tighter because a token is cached and
 * re-authenticating in a loop is always a bug.
 */
export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  session: { limit: 10, windowMs: 60_000, minIntervalMs: 500 },
  default: { limit: 60, windowMs: 60_000, minIntervalMs: 100 },
};

interface Bucket {
  timestamps: number[];
  lastAt: number;
}

const buckets = new Map<string, Bucket>();

export function resetRateLimiter() {
  buckets.clear();
}

export class RateLimitExceededError extends Error {
  readonly retryAfterMs: number;
  constructor(operation: string, retryAfterMs: number) {
    super(`Local rate limit reached for ABDM ${operation}; refusing to send.`);
    this.name = "RateLimitExceededError";
    this.retryAfterMs = retryAfterMs;
  }
}

function configFor(operation: string): RateLimitConfig {
  return DEFAULT_RATE_LIMITS[operation] ?? DEFAULT_RATE_LIMITS.default;
}

/**
 * Check (and record) one call against the limiter.
 *
 * Throws rather than sleeping: silently delaying a clinical-adjacent operation
 * hides a problem, whereas an explicit refusal with a retry hint is visible in
 * the exchange record and to the operator.
 */
export function consumeRateLimit(operation: string, now = Date.now()): void {
  const config = configFor(operation);
  const bucket = buckets.get(operation) ?? { timestamps: [], lastAt: 0 };

  if (bucket.lastAt && now - bucket.lastAt < config.minIntervalMs) {
    throw new RateLimitExceededError(operation, config.minIntervalMs - (now - bucket.lastAt));
  }

  const cutoff = now - config.windowMs;
  bucket.timestamps = bucket.timestamps.filter((t) => t > cutoff);

  if (bucket.timestamps.length >= config.limit) {
    const oldest = bucket.timestamps[0];
    throw new RateLimitExceededError(operation, Math.max(0, oldest + config.windowMs - now));
  }

  bucket.timestamps.push(now);
  bucket.lastAt = now;
  buckets.set(operation, bucket);
}

/** Current usage, for the observability panel. Never blocks. */
export function describeRateLimit(operation: string, now = Date.now()) {
  const config = configFor(operation);
  const bucket = buckets.get(operation);
  const used = bucket ? bucket.timestamps.filter((t) => t > now - config.windowMs).length : 0;
  return { operation, used, limit: config.limit, windowMs: config.windowMs, remaining: Math.max(0, config.limit - used) };
}
