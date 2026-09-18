/**
 * Phase D8 — in-process effective-configuration cache (§37).
 *
 * Deliberately NOT Redis. A tiny per-process cache of resolved CURRENT values
 * (atTime = now), guarded by a per-organization generation counter: any write to an
 * organization's config bumps its generation, which invalidates every cached entry
 * for that org. Time-travel lookups (explicit atTime) bypass the cache entirely, so
 * correctness never depends on stale configuration.
 */

interface Entry {
  gen: number;
  expires: number;
  value: unknown;
}

const TTL_MS = 5_000;
const generation = new Map<string, number>();
const store = new Map<string, Entry>(); // key: `${orgId}|${cacheKey}`

function gen(orgId: string): number {
  return generation.get(orgId) ?? 0;
}

export function cacheKeyFor(orgId: string, scope: string, scopeRef: string, key: string): string {
  return `${orgId}|${scope}:${scopeRef}:${key}`;
}

export function cacheGet(orgId: string, cacheKey: string): { hit: boolean; value: unknown } {
  const e = store.get(cacheKey);
  if (!e) return { hit: false, value: undefined };
  if (e.gen !== gen(orgId) || e.expires < Date.now()) {
    store.delete(cacheKey);
    return { hit: false, value: undefined };
  }
  return { hit: true, value: e.value };
}

export function cacheSet(orgId: string, cacheKey: string, value: unknown): void {
  store.set(cacheKey, { gen: gen(orgId), expires: Date.now() + TTL_MS, value });
}

/** Invalidate all cached configuration for an organization (call after any write). */
export function invalidateOrg(orgId: string): void {
  generation.set(orgId, gen(orgId) + 1);
}

/** Test/reset helper. */
export function clearConfigCache(): void {
  store.clear();
  generation.clear();
}
