import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import {
  type ActorMemberships,
  assertOrganizationAccess,
  assertOrganizationAdmin,
  assertFacilityAdmin,
  canAccessFacility,
} from "@/lib/auth/tenantContext";
import { CONFIG_KEYS, isKnownConfigKey, type ConfigKey, type ConfigScope } from "./constants";

/**
 * Phase D1 — hierarchical configuration.
 *
 * Resolution order, most specific first:
 *   department override → facility override → organization override → default.
 *
 * Only EXPLICIT overrides are stored as rows. The absence of a row at a level
 * means "inherit". Reset deletes the row (it does not write a sentinel), so an
 * inherited value is always distinguishable from an override by whether a row
 * exists. Every configurable key is in the closed CONFIG_KEYS registry; an
 * unknown key is refused rather than silently stored.
 */

export interface ResolvedConfig {
  key: ConfigKey;
  value: string;
  /** Which level supplied the effective value. */
  source: ConfigScope;
  /** True unless the value came from the hard-coded default. */
  explicit: boolean;
}

function assertKnownKey(key: string): asserts key is ConfigKey {
  if (!isKnownConfigKey(key)) throw new BadRequestError(`Unknown configuration key: ${key}`);
}

/** Read access to a facility (membership or admin), returning its organization. */
async function facilityReadContext(m: ActorMemberships, facilityId: string): Promise<string> {
  const fac = await prisma.facility.findUnique({ where: { id: facilityId }, select: { organizationId: true } });
  if (!fac) throw new NotFoundError();
  if (!canAccessFacility(m, facilityId, fac.organizationId)) throw new NotFoundError();
  return fac.organizationId;
}

export async function resolveConfig(
  m: ActorMemberships,
  args: { key: string; organizationId: string; facilityId?: string | null; departmentId?: string | null }
): Promise<ResolvedConfig> {
  assertKnownKey(args.key);

  // Scope access: resolving at facility/department level requires facility
  // access; org-level requires org standing.
  if (args.departmentId) {
    const dept = await prisma.department.findUnique({ where: { id: args.departmentId }, select: { facilityId: true } });
    if (!dept) throw new NotFoundError();
    if (args.facilityId && dept.facilityId !== args.facilityId) throw new BadRequestError("Department does not belong to that facility.");
    await facilityReadContext(m, dept.facilityId);
  } else if (args.facilityId) {
    await facilityReadContext(m, args.facilityId);
  } else {
    assertOrganizationAccess(m, args.organizationId);
  }

  if (args.departmentId) {
    const row = await prisma.departmentConfigValue.findUnique({
      where: { departmentId_key: { departmentId: args.departmentId, key: args.key } },
    });
    if (row) return { key: args.key, value: row.value, source: "department", explicit: true };
  }
  if (args.facilityId) {
    const row = await prisma.facilityConfigValue.findUnique({
      where: { facilityId_key: { facilityId: args.facilityId, key: args.key } },
    });
    if (row) return { key: args.key, value: row.value, source: "facility", explicit: true };
  }
  const orgRow = await prisma.orgConfigValue.findUnique({
    where: { organizationId_key: { organizationId: args.organizationId, key: args.key } },
  });
  if (orgRow) return { key: args.key, value: orgRow.value, source: "organization", explicit: true };

  return { key: args.key, value: CONFIG_KEYS[args.key].default, source: "default", explicit: false };
}

/** Resolve every known key for a scope (for the config UI). */
export async function resolveAllConfig(
  m: ActorMemberships,
  args: { organizationId: string; facilityId?: string | null; departmentId?: string | null }
): Promise<ResolvedConfig[]> {
  const keys = Object.keys(CONFIG_KEYS) as ConfigKey[];
  const out: ResolvedConfig[] = [];
  for (const key of keys) {
    out.push(await resolveConfig(m, { key, ...args }));
  }
  return out;
}

export async function setOrgConfig(m: ActorMemberships, organizationId: string, key: string, value: string) {
  assertKnownKey(key);
  assertOrganizationAdmin(m, organizationId);
  const row = await prisma.orgConfigValue.upsert({
    where: { organizationId_key: { organizationId, key } },
    update: { value, updatedByUserId: m.userId },
    create: { organizationId, key, value, updatedByUserId: m.userId },
  });
  await recordAuditEvent("enterprise.config.overridden", m.userId, { scope: "organization", key }, { organizationId });
  return row;
}

export async function setFacilityConfig(m: ActorMemberships, facilityId: string, key: string, value: string) {
  assertKnownKey(key);
  const { organizationId } = await assertFacilityAdmin(m, facilityId);
  const row = await prisma.facilityConfigValue.upsert({
    where: { facilityId_key: { facilityId, key } },
    update: { value, updatedByUserId: m.userId },
    create: { facilityId, key, value, updatedByUserId: m.userId },
  });
  await recordAuditEvent("enterprise.config.overridden", m.userId, { scope: "facility", key }, { organizationId, facilityId });
  return row;
}

export async function setDepartmentConfig(m: ActorMemberships, departmentId: string, key: string, value: string) {
  assertKnownKey(key);
  const dept = await prisma.department.findUnique({ where: { id: departmentId }, select: { facilityId: true } });
  if (!dept) throw new NotFoundError();
  const { organizationId } = await assertFacilityAdmin(m, dept.facilityId);
  const row = await prisma.departmentConfigValue.upsert({
    where: { departmentId_key: { departmentId, key } },
    update: { value, updatedByUserId: m.userId },
    create: { departmentId, key, value, updatedByUserId: m.userId },
  });
  await recordAuditEvent(
    "enterprise.config.overridden",
    m.userId,
    { scope: "department", key },
    { organizationId, facilityId: dept.facilityId }
  );
  return row;
}

export async function resetOrgConfig(m: ActorMemberships, organizationId: string, key: string) {
  assertKnownKey(key);
  assertOrganizationAdmin(m, organizationId);
  await prisma.orgConfigValue.deleteMany({ where: { organizationId, key } });
  await recordAuditEvent("enterprise.config.reset", m.userId, { scope: "organization", key }, { organizationId });
}

export async function resetFacilityConfig(m: ActorMemberships, facilityId: string, key: string) {
  assertKnownKey(key);
  const { organizationId } = await assertFacilityAdmin(m, facilityId);
  await prisma.facilityConfigValue.deleteMany({ where: { facilityId, key } });
  await recordAuditEvent("enterprise.config.reset", m.userId, { scope: "facility", key }, { organizationId, facilityId });
}

export async function resetDepartmentConfig(m: ActorMemberships, departmentId: string, key: string) {
  assertKnownKey(key);
  const dept = await prisma.department.findUnique({ where: { id: departmentId }, select: { facilityId: true } });
  if (!dept) throw new NotFoundError();
  const { organizationId } = await assertFacilityAdmin(m, dept.facilityId);
  await prisma.departmentConfigValue.deleteMany({ where: { departmentId, key } });
  await recordAuditEvent(
    "enterprise.config.reset",
    m.userId,
    { scope: "department", key },
    { organizationId, facilityId: dept.facilityId }
  );
}
