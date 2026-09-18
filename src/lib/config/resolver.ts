import { prisma } from "@/lib/db";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { resolveKeySpec } from "./registry";
import { ConfigError, type ChainEntry, type EffectiveConfig, type ResolutionSource } from "./types";
import { assertCanReadScope } from "./authz";
import { cacheKeyFor, cacheGet, cacheSet } from "./cache";

/**
 * Phase D8 — the ONE authoritative effective-configuration resolver (§10/§11).
 *
 * Precedence, most specific first: DEPARTMENT → FACILITY → ORGANIZATION → SYSTEM
 * default (registry default, or a caller-supplied fallback e.g. a D7 workflow
 * version's own SLA). Only PUBLISHED overrides whose effective window contains the
 * requested time win. The result carries full provenance (the whole chain + winning
 * source + version) so enterprise support can answer "why is this value active?".
 * Modules must never implement their own precedence — they call this.
 */

export interface ResolveArgs {
  key: string;
  organizationId: string;
  facilityId?: string | null;
  departmentId?: string | null;
  atTime?: Date;
  /** SYSTEM-level fallback raw value when the registry has no default (e.g. D7 SLA). */
  fallbackRaw?: string | null;
}

async function loadLevel(scope: "DEPARTMENT" | "FACILITY" | "ORGANIZATION", scopeRef: string, key: string, at: Date) {
  return prisma.configurationOverride.findFirst({
    where: { scope, scopeRef, key, status: "PUBLISHED", effectiveFrom: { lte: at }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: at } }] },
    orderBy: { effectiveFrom: "desc" },
    select: { value: true, version: true },
  });
}

/** Server-internal resolution (no ActorMemberships check) — for trusted callers
 * (e.g. the D7 engine) that have already established tenant scope from an event. */
export async function resolveEffectiveInternal(args: ResolveArgs): Promise<EffectiveConfig> {
  const spec = resolveKeySpec(args.key);
  if (!spec) throw new ConfigError(`Unknown configuration key: ${args.key}`);
  const at = args.atTime ?? new Date();

  // Determine the facility for the chain (dept implies its facility).
  let facilityId = args.facilityId ?? null;
  if (args.departmentId && !facilityId) {
    const dept = await prisma.department.findUnique({ where: { id: args.departmentId }, select: { facilityId: true } });
    facilityId = dept?.facilityId ?? null;
  }

  const useCache = !args.atTime && !args.fallbackRaw;
  const deepestScope = args.departmentId ? "DEPARTMENT" : facilityId ? "FACILITY" : "ORGANIZATION";
  const deepestRef = args.departmentId ?? facilityId ?? args.organizationId;
  const ck = cacheKeyFor(args.organizationId, deepestScope, deepestRef, args.key);
  if (useCache) {
    const c = cacheGet(args.organizationId, ck);
    if (c.hit) return c.value as EffectiveConfig;
  }

  const chain: ChainEntry[] = [];
  const push = async (source: ResolutionSource, sourceId: string | null) => {
    if (source === "SYSTEM") {
      const raw = spec.hasDefault ? spec.default : (args.fallbackRaw ?? null);
      chain.push({ source, sourceId: null, present: raw !== null, value: raw !== null ? spec.parse(raw) : null, raw, version: null });
      return;
    }
    if (source === "UNSET" || !sourceId) return;
    const row = await loadLevel(source, sourceId, args.key, at);
    chain.push({ source, sourceId, present: !!row, value: row ? spec.parse(row.value) : null, raw: row?.value ?? null, version: row?.version ?? null });
  };

  if (args.departmentId) await push("DEPARTMENT", args.departmentId);
  if (facilityId) await push("FACILITY", facilityId);
  await push("ORGANIZATION", args.organizationId);
  await push("SYSTEM", null);

  const winner = chain.find((c) => c.present) ?? { source: "UNSET" as ResolutionSource, sourceId: null, present: false, value: null, raw: null, version: null };
  const winnerIdx = chain.indexOf(winner as ChainEntry);
  const inheritedFrom = chain.slice(winnerIdx + 1).find((c) => c.present)?.source ?? null;

  const result: EffectiveConfig = {
    key: args.key,
    valueType: spec.valueType,
    value: winner.value,
    raw: winner.raw,
    source: winner.source,
    sourceId: winner.sourceId,
    version: winner.version,
    inheritedFrom,
    atTime: at.toISOString(),
    chain,
  };
  if (useCache) cacheSet(args.organizationId, ck, result);
  return result;
}

/** Authorized resolution (used by routes / actor-scoped callers). */
export async function resolveConfig(m: ActorMemberships, args: ResolveArgs): Promise<EffectiveConfig> {
  const spec = resolveKeySpec(args.key);
  if (!spec) throw new ConfigError(`Unknown configuration key: ${args.key}`);
  const scope = args.departmentId ? "DEPARTMENT" : args.facilityId ? "FACILITY" : "ORGANIZATION";
  await assertCanReadScope(m, { scope, organizationId: args.organizationId, facilityId: args.facilityId, departmentId: args.departmentId });
  return resolveEffectiveInternal(args);
}

/** The explainer (§43): same as resolveConfig, kept as a named entry point. */
export const explainConfig = resolveConfig;

/**
 * Snapshot a set of effective keys for historical explainability (§38). Used by D7
 * to freeze a workflow's effective SLA at instance/step creation so a later config
 * change never retroactively moves an in-flight deadline. Server-internal.
 */
export async function snapshotConfig(
  args: { organizationId: string; facilityId?: string | null; departmentId?: string | null; atTime?: Date },
  keys: { key: string; fallbackRaw?: string | null }[],
): Promise<Record<string, { value: unknown; raw: string | null; source: ResolutionSource; version: number | null }>> {
  const out: Record<string, { value: unknown; raw: string | null; source: ResolutionSource; version: number | null }> = {};
  for (const k of keys) {
    const eff = await resolveEffectiveInternal({ key: k.key, ...args, fallbackRaw: k.fallbackRaw ?? null });
    out[k.key] = { value: eff.value, raw: eff.raw, source: eff.source, version: eff.version };
  }
  return out;
}
