import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { resolveKeySpec } from "./registry";
import { resolveScopeRef, assertCanConfigureScope, assertCanReadScope, type ScopeArgs } from "./authz";
import { invalidateOrg } from "./cache";
import { CONFIG_LIMITS, ConfigError } from "./types";

/**
 * Phase D8 — governed override lifecycle (§8/§9/§12/§13/§32).
 *
 * Editing lands as a DRAFT (version 0) and does NOT affect runtime. Publishing
 * assigns the next version, makes it PUBLISHED with an effective window, and closes
 * the previous current value — race-safe via a guarded transition. Reset retires the
 * current value so the scope inherits. Every change is recorded in the immutable
 * ConfigurationChange ledger and audited. Platform-only keys stay platform-only, and
 * tenant scope is server-derived (never client-authoritative).
 */

const DRAFT_VERSION = 0;

export interface SetInput extends ScopeArgs {
  key: string;
  value: string;
  reason?: string;
}

/** Create or update the DRAFT value for a (scope, key). Not live until published. */
export async function setOverride(m: ActorMemberships, input: SetInput) {
  const spec = resolveKeySpec(input.key);
  if (!spec) throw new BadRequestError(`Unknown configuration key: ${input.key}`);
  await assertCanConfigureScope(m, input, spec);
  const resolved = await resolveScopeRef(input);
  const normalized = spec.normalize(input.value); // validates + canonicalizes (throws on invalid)

  // Bound the number of overrides per scope (config-explosion guard).
  const count = await prisma.configurationOverride.count({ where: { scope: input.scope, scopeRef: resolved.scopeRef } });
  if (count > CONFIG_LIMITS.MAX_OVERRIDES_PER_SCOPE) throw new ConfigError("Too many configuration entries for this scope.");

  const existingDraft = await prisma.configurationOverride.findUnique({
    where: { scope_scopeRef_key_version: { scope: input.scope, scopeRef: resolved.scopeRef, key: input.key, version: DRAFT_VERSION } },
  });
  let oldValue: string | null = existingDraft?.value ?? null;

  const row = await prisma.$transaction(async (tx) => {
    let r;
    if (existingDraft) {
      r = await tx.configurationOverride.update({ where: { id: existingDraft.id }, data: { value: normalized, valueType: spec.valueType, reason: input.reason ?? null, updatedByUserId: m.userId } });
    } else {
      try {
        r = await tx.configurationOverride.create({
          data: {
            key: input.key, valueType: spec.valueType, scope: input.scope, scopeRef: resolved.scopeRef,
            organizationId: resolved.organizationId, facilityId: resolved.facilityId, departmentId: resolved.departmentId,
            value: normalized, status: "DRAFT", version: DRAFT_VERSION, reason: input.reason ?? null,
            createdByUserId: m.userId, updatedByUserId: m.userId,
          },
        });
      } catch (err) {
        if ((err as { code?: string }).code !== "P2002") throw err;
        // A concurrent create won the draft slot — update it instead (deterministic last-writer).
        const draft = await tx.configurationOverride.findUniqueOrThrow({ where: { scope_scopeRef_key_version: { scope: input.scope, scopeRef: resolved.scopeRef, key: input.key, version: DRAFT_VERSION } } });
        oldValue = draft.value;
        r = await tx.configurationOverride.update({ where: { id: draft.id }, data: { value: normalized, reason: input.reason ?? null, updatedByUserId: m.userId } });
      }
    }
    await tx.configurationChange.create({ data: { overrideId: r.id, key: input.key, scope: input.scope, scopeRef: resolved.scopeRef, organizationId: resolved.organizationId, action: "SET", oldValue, newValue: normalized, version: DRAFT_VERSION, actorUserId: m.userId, reason: input.reason ?? null } });
    await recordAuditEvent("configuration.set", m.userId, { key: input.key, scope: input.scope }, { organizationId: resolved.organizationId, facilityId: resolved.facilityId ?? undefined }, tx);
    return r;
  });
  return row;
}

export interface PublishInput extends ScopeArgs {
  key: string;
  effectiveFrom?: Date;
  reason?: string;
}

/**
 * Publish the DRAFT for a (scope, key). Race-safe: the guarded DRAFT→PUBLISHED
 * transition means two concurrent publishes cannot both win, so no duplicate active
 * publication and no duplicate version. Effective-date overlap is rejected.
 */
export async function publishOverride(m: ActorMemberships, input: PublishInput) {
  const spec = resolveKeySpec(input.key);
  if (!spec) throw new BadRequestError(`Unknown configuration key: ${input.key}`);
  await assertCanConfigureScope(m, input, spec);
  const resolved = await resolveScopeRef(input);
  const now = new Date();
  const effectiveFrom = input.effectiveFrom && input.effectiveFrom > now ? input.effectiveFrom : now;
  const scheduled = effectiveFrom > now;

  const published = await prisma.$transaction(async (tx) => {
    const draft = await tx.configurationOverride.findUnique({
      where: { scope_scopeRef_key_version: { scope: input.scope, scopeRef: resolved.scopeRef, key: input.key, version: DRAFT_VERSION } },
    });
    if (!draft) throw new BadRequestError("No draft to publish for this key at this scope.");
    spec.parse(draft.value); // re-validate the immutable payload before it goes live

    // Effective-date overlap protection.
    if (scheduled) {
      const conflict = await tx.configurationOverride.findFirst({
        where: { scope: input.scope, scopeRef: resolved.scopeRef, key: input.key, status: "PUBLISHED", OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: effectiveFrom } }], effectiveFrom: { gte: now } },
        select: { id: true },
      });
      if (conflict) throw new ConflictError("An overlapping scheduled configuration already exists; reset it first.");
    }

    const maxV = await tx.configurationOverride.aggregate({ where: { scope: input.scope, scopeRef: resolved.scopeRef, key: input.key, status: { in: ["PUBLISHED", "RETIRED"] } }, _max: { version: true } });
    const nextVersion = (maxV._max.version ?? 0) + 1;

    // Guarded promotion — only one concurrent publisher flips the draft.
    const promoted = await tx.configurationOverride.updateMany({
      where: { id: draft.id, status: "DRAFT" },
      data: { status: "PUBLISHED", version: nextVersion, effectiveFrom, effectiveUntil: null, updatedByUserId: m.userId },
    });
    if (promoted.count !== 1) throw new ConflictError("Draft was published concurrently.");

    // Bound the previous open value so windows never overlap: it stays PUBLISHED
    // (queryable history) but ends exactly when this one begins. RETIRED is reserved
    // for reset. Only prior values that start before this one are closed.
    await tx.configurationOverride.updateMany({
      where: { scope: input.scope, scopeRef: resolved.scopeRef, key: input.key, status: "PUBLISHED", effectiveUntil: null, effectiveFrom: { lt: effectiveFrom }, id: { not: draft.id } },
      data: { effectiveUntil: effectiveFrom },
    });

    await tx.configurationChange.create({ data: { overrideId: draft.id, key: input.key, scope: input.scope, scopeRef: resolved.scopeRef, organizationId: resolved.organizationId, action: "PUBLISH", newValue: draft.value, version: nextVersion, actorUserId: m.userId, reason: input.reason ?? null } });
    await recordAuditEvent("configuration.published", m.userId, { key: input.key, scope: input.scope, version: nextVersion, effectiveFrom: effectiveFrom.toISOString() }, { organizationId: resolved.organizationId, facilityId: resolved.facilityId ?? undefined }, tx);
    return tx.configurationOverride.findUniqueOrThrow({ where: { id: draft.id } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });

  invalidateOrg(resolved.organizationId);
  return published;
}

/** Reset: retire the current published value (so the scope inherits) and drop any draft. */
export async function resetOverride(m: ActorMemberships, input: ScopeArgs & { key: string; reason?: string }) {
  const spec = resolveKeySpec(input.key);
  if (!spec) throw new BadRequestError(`Unknown configuration key: ${input.key}`);
  await assertCanConfigureScope(m, input, spec);
  const resolved = await resolveScopeRef(input);
  await prisma.$transaction(async (tx) => {
    const current = await tx.configurationOverride.updateMany({
      where: { scope: input.scope, scopeRef: resolved.scopeRef, key: input.key, status: "PUBLISHED", effectiveUntil: null },
      data: { status: "RETIRED", effectiveUntil: new Date() },
    });
    await tx.configurationOverride.deleteMany({ where: { scope: input.scope, scopeRef: resolved.scopeRef, key: input.key, status: "DRAFT" } });
    await tx.configurationChange.create({ data: { key: input.key, scope: input.scope, scopeRef: resolved.scopeRef, organizationId: resolved.organizationId, action: "RESET", actorUserId: m.userId, reason: input.reason ?? null } });
    await recordAuditEvent("configuration.reset", m.userId, { key: input.key, scope: input.scope, retired: current.count }, { organizationId: resolved.organizationId, facilityId: resolved.facilityId ?? undefined }, tx);
  });
  invalidateOrg(resolved.organizationId);
  return { reset: true };
}

/** Immutable change history for a (scope, key), tenant-scoped. */
export async function getHistory(m: ActorMemberships, input: ScopeArgs & { key: string; limit?: number }) {
  await assertCanReadScope(m, input);
  const resolved = await resolveScopeRef(input);
  return prisma.configurationChange.findMany({
    where: { scope: input.scope, scopeRef: resolved.scopeRef, key: input.key },
    orderBy: { createdAt: "desc" }, take: Math.min(input.limit ?? 100, 500),
  });
}

/** List all overrides currently defined for an organization (for the admin UI), scoped. */
export async function listOverrides(m: ActorMemberships, organizationId: string, opts?: { status?: string }) {
  await assertCanReadScope(m, { scope: "ORGANIZATION", organizationId });
  return prisma.configurationOverride.findMany({
    where: { organizationId, ...(opts?.status ? { status: opts.status } : {}) },
    orderBy: [{ key: "asc" }, { scope: "asc" }, { version: "desc" }],
    take: 1000,
  });
}
