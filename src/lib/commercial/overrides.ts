import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/auth/rbac";
import type { ActorMemberships } from "@/lib/auth/tenantContext";
import { getEntitlementSpec } from "./registry";

/**
 * Phase D2 — commercial overrides.
 *
 * Overrides raise or lower what a plan grants for a specific organization or
 * facility (e.g. an enterprise contract lifts max_facilities above the plan).
 * They are PLATFORM-only: an organization administrator can NEVER grant
 * themselves an override — that would be self-service commercial escalation.
 * Every override is explicit, scoped, actor-stamped, optionally expiring, and
 * audited; it never mutates plan or subscription data.
 */

function requirePlatform(m: ActorMemberships) {
  if (!m.isPlatformAdmin) throw new ForbiddenError("commercial:platform:manage");
}

export interface OverrideValue {
  key: string;
  boolValue?: boolean | null;
  numberValue?: number | null;
  unlimited?: boolean;
  reason?: string | null;
  expiresAt?: Date | null;
}

async function loadDef(key: string) {
  const spec = getEntitlementSpec(key);
  if (!spec) throw new BadRequestError(`Unknown entitlement: ${key}`);
  const def = await prisma.entitlementDefinition.findUnique({ where: { key } });
  if (!def) throw new BadRequestError("Entitlement registry not bootstrapped.");
  return { spec, def };
}

export async function setOrganizationOverride(m: ActorMemberships, organizationId: string, v: OverrideValue) {
  requirePlatform(m);
  const { def } = await loadDef(v.key);
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
  if (!org) throw new NotFoundError();

  const existed = await prisma.organizationEntitlementOverride.findUnique({
    where: { organizationId_entitlementId: { organizationId, entitlementId: def.id } },
    select: { id: true },
  });
  const row = await prisma.organizationEntitlementOverride.upsert({
    where: { organizationId_entitlementId: { organizationId, entitlementId: def.id } },
    update: { boolValue: v.boolValue ?? null, numberValue: v.numberValue ?? null, unlimited: v.unlimited ?? false, reason: v.reason ?? null, expiresAt: v.expiresAt ?? null, createdByUserId: m.userId },
    create: { organizationId, entitlementId: def.id, boolValue: v.boolValue ?? null, numberValue: v.numberValue ?? null, unlimited: v.unlimited ?? false, reason: v.reason ?? null, expiresAt: v.expiresAt ?? null, createdByUserId: m.userId },
  });
  await recordAuditEvent(existed ? "commercial.override.updated" : "commercial.override.created", m.userId, { scope: "organization", key: v.key }, { organizationId });
  return row;
}

export async function removeOrganizationOverride(m: ActorMemberships, organizationId: string, key: string) {
  requirePlatform(m);
  const { def } = await loadDef(key);
  await prisma.organizationEntitlementOverride.deleteMany({ where: { organizationId, entitlementId: def.id } });
  await recordAuditEvent("commercial.override.removed", m.userId, { scope: "organization", key }, { organizationId });
}

export async function setFacilityOverride(m: ActorMemberships, facilityId: string, v: OverrideValue) {
  requirePlatform(m);
  const { spec, def } = await loadDef(v.key);
  if (spec.scope !== "FACILITY") throw new BadRequestError(`${v.key} is an organization-scoped entitlement; use an organization override.`);
  const facility = await prisma.facility.findUnique({ where: { id: facilityId }, select: { id: true, organizationId: true } });
  if (!facility) throw new NotFoundError();

  const existed = await prisma.facilityEntitlementOverride.findUnique({
    where: { facilityId_entitlementId: { facilityId, entitlementId: def.id } },
    select: { id: true },
  });
  const row = await prisma.facilityEntitlementOverride.upsert({
    where: { facilityId_entitlementId: { facilityId, entitlementId: def.id } },
    update: { boolValue: v.boolValue ?? null, numberValue: v.numberValue ?? null, unlimited: v.unlimited ?? false, reason: v.reason ?? null, expiresAt: v.expiresAt ?? null, createdByUserId: m.userId },
    create: { facilityId, entitlementId: def.id, boolValue: v.boolValue ?? null, numberValue: v.numberValue ?? null, unlimited: v.unlimited ?? false, reason: v.reason ?? null, expiresAt: v.expiresAt ?? null, createdByUserId: m.userId },
  });
  await recordAuditEvent(existed ? "commercial.override.updated" : "commercial.override.created", m.userId, { scope: "facility", key: v.key }, { organizationId: facility.organizationId, facilityId });
  return row;
}

export async function removeFacilityOverride(m: ActorMemberships, facilityId: string, key: string) {
  requirePlatform(m);
  const { def } = await loadDef(key);
  const facility = await prisma.facility.findUnique({ where: { id: facilityId }, select: { organizationId: true } });
  if (!facility) throw new NotFoundError();
  await prisma.facilityEntitlementOverride.deleteMany({ where: { facilityId, entitlementId: def.id } });
  await recordAuditEvent("commercial.override.removed", m.userId, { scope: "facility", key }, { organizationId: facility.organizationId, facilityId });
}
