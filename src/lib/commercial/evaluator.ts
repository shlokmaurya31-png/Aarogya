import { prisma } from "@/lib/db";
import type { EntitlementType, SubscriptionStatus } from "@prisma/client";
import { getEntitlementSpec } from "./registry";
import { isCommercialActive } from "./constants";

/**
 * Phase D2 — the ONE authoritative entitlement evaluator.
 *
 * There is exactly one place that answers "is organization X allowed capability
 * Y (optionally at facility F)?". No `if (plan === "enterprise")` anywhere else.
 *
 * IMPORTANT: this evaluates against a SERVER-RESOLVED tenant. Callers pass an
 * organizationId (and optional facilityId) that they have already validated
 * through the D1 tenant context — never a raw client-supplied id. Entitlement is
 * a SEPARATE concern from authorization: a positive result never grants access
 * that C4/D1 would deny, and this function performs no tenant-membership check
 * itself.
 *
 * Resolution precedence (most specific first):
 *   facility override → organization override → subscription snapshot → default
 * Commercial state then gates BOOLEAN capabilities: a SUSPENDED/CANCELLED/EXPIRED
 * subscription disables premium features (never deletes data, never gates
 * safety-critical clinical access — that is C4's job, not commerce's).
 */

export type EntitlementSource =
  | "FACILITY_OVERRIDE" | "ORGANIZATION_OVERRIDE" | "SUBSCRIPTION" | "DEFAULT" | "NONE";

export interface EntitlementResult {
  key: string;
  type: EntitlementType;
  /** BOOLEAN: the effective flag AND commercial-active. Always false for non-BOOLEAN. */
  allowed: boolean;
  /** The raw effective value before the commercial-state gate. */
  value: boolean | number | null;
  /** LIMIT/NUMBER: the effective cap; null means unlimited (LIMIT) or unset. */
  limit: number | null;
  unlimited: boolean;
  source: EntitlementSource;
  commercialStatus: SubscriptionStatus | "NONE";
  commercialActive: boolean;
  reason?: string;
}

interface ValueRow { boolValue: boolean | null; numberValue: number | null; unlimited: boolean; expiresAt?: Date | null }

function notExpired(row: { expiresAt?: Date | null }, now: Date): boolean {
  return !row.expiresAt || row.expiresAt > now;
}

/**
 * Derive whether the subscription is commercially active RIGHT NOW, honouring
 * lazy expiry (a TRIAL past its end, or a cancel-at-period-end past its period)
 * even if a sweep has not yet transitioned the row. Expiry is derived from
 * timestamps, never trusted from the status column alone.
 */
export function deriveCommercialState(
  sub: { status: SubscriptionStatus; trialEndsAt: Date | null; cancelAtPeriodEnd: boolean; currentPeriodEnd: Date | null } | null,
  now: Date
): { status: SubscriptionStatus | "NONE"; active: boolean; reason?: string } {
  if (!sub) return { status: "NONE", active: false, reason: "NO_SUBSCRIPTION" };
  if (sub.status === "TRIAL" && sub.trialEndsAt && sub.trialEndsAt <= now) return { status: sub.status, active: false, reason: "TRIAL_ENDED" };
  if (sub.cancelAtPeriodEnd && sub.currentPeriodEnd && sub.currentPeriodEnd <= now) return { status: sub.status, active: false, reason: "PERIOD_ENDED" };
  const active = isCommercialActive(sub.status);
  return { status: sub.status, active, reason: active ? undefined : sub.status };
}

export async function evaluateEntitlement(
  args: { organizationId: string; facilityId?: string | null; key: string; now?: Date }
): Promise<EntitlementResult> {
  const spec = getEntitlementSpec(args.key);
  if (!spec) throw new Error(`Unknown entitlement: ${args.key}`);
  const now = args.now ?? new Date();

  const def = await prisma.entitlementDefinition.findUnique({ where: { key: args.key } });

  const sub = await prisma.organizationSubscription.findUnique({
    where: { organizationId: args.organizationId },
    select: { id: true, status: true, trialEndsAt: true, cancelAtPeriodEnd: true, currentPeriodEnd: true },
  });
  const commercial = deriveCommercialState(sub, now);

  // Resolve the effective value by precedence.
  let chosen: ValueRow | null = null;
  let source: EntitlementSource = "NONE";

  if (def) {
    if (spec.scope === "FACILITY" && args.facilityId) {
      const fo = await prisma.facilityEntitlementOverride.findUnique({
        where: { facilityId_entitlementId: { facilityId: args.facilityId, entitlementId: def.id } },
      });
      if (fo && notExpired(fo, now)) { chosen = fo; source = "FACILITY_OVERRIDE"; }
    }
    if (!chosen) {
      const oo = await prisma.organizationEntitlementOverride.findUnique({
        where: { organizationId_entitlementId: { organizationId: args.organizationId, entitlementId: def.id } },
      });
      if (oo && notExpired(oo, now)) { chosen = oo; source = "ORGANIZATION_OVERRIDE"; }
    }
    if (!chosen && sub) {
      const se = await prisma.subscriptionEntitlement.findUnique({
        where: { subscriptionId_entitlementId: { subscriptionId: sub.id, entitlementId: def.id } },
      });
      if (se) { chosen = se; source = "SUBSCRIPTION"; }
    }
  }

  // Fall back to the definition default (DB default, else the registry spec).
  if (!chosen) {
    chosen = {
      boolValue: def?.defaultBool ?? spec.defaultBool ?? null,
      numberValue: def?.defaultNumber ?? spec.defaultNumber ?? null,
      unlimited: def?.defaultUnlimited ?? spec.defaultUnlimited ?? false,
    };
    source = "DEFAULT";
  }

  if (spec.type === "BOOLEAN") {
    const raw = chosen.boolValue ?? false;
    return {
      key: args.key, type: spec.type, value: raw, limit: null, unlimited: false, source,
      commercialStatus: commercial.status, commercialActive: commercial.active,
      allowed: raw && commercial.active,
      reason: raw ? (commercial.active ? undefined : commercial.reason) : "NOT_IN_PLAN",
    };
  }

  // LIMIT / NUMBER
  const unlimited = chosen.unlimited;
  const limit = unlimited ? null : (chosen.numberValue ?? null);
  return {
    key: args.key, type: spec.type, value: chosen.numberValue ?? null, limit, unlimited, source,
    commercialStatus: commercial.status, commercialActive: commercial.active,
    allowed: false, // not meaningful for numeric entitlements; use resolveLimit / enforceLimit
    reason: commercial.active ? undefined : commercial.reason,
  };
}

/** Convenience: is a BOOLEAN capability enabled for this tenant right now? */
export async function hasEntitlement(args: { organizationId: string; facilityId?: string | null; key: string; now?: Date }): Promise<boolean> {
  const r = await evaluateEntitlement(args);
  return r.allowed;
}

/** Resolve a LIMIT entitlement to its effective cap. */
export async function resolveLimit(args: { organizationId: string; key: string; now?: Date }): Promise<{ limit: number | null; unlimited: boolean; commercialActive: boolean; commercialStatus: SubscriptionStatus | "NONE" }> {
  const r = await evaluateEntitlement(args);
  return { limit: r.limit, unlimited: r.unlimited, commercialActive: r.commercialActive, commercialStatus: r.commercialStatus };
}
