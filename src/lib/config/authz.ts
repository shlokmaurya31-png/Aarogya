import { prisma } from "@/lib/db";
import { ForbiddenError, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import {
  type ActorMemberships, assertOrganizationAccess, assertOrganizationAdmin,
  assertFacilityAdmin, canAccessFacility,
} from "@/lib/auth/tenantContext";
import type { KeySpec, Scope } from "./types";

/**
 * Phase D8 — configuration authorization (§5/§30/§31). Reuses D1 tenant context +
 * C4; adds no parallel RBAC. Configuration never grants access — C4 stays
 * authoritative. Platform-only keys can never be set by an org/facility admin.
 */

export interface ScopeArgs {
  scope: Scope;
  organizationId: string;
  facilityId?: string | null;
  departmentId?: string | null;
}

/** Resolve + verify the concrete scopeRef, checking the resource belongs to the tenant. */
export async function resolveScopeRef(args: ScopeArgs): Promise<{ scopeRef: string; organizationId: string; facilityId: string | null; departmentId: string | null }> {
  if (args.scope === "ORGANIZATION") {
    return { scopeRef: args.organizationId, organizationId: args.organizationId, facilityId: null, departmentId: null };
  }
  if (args.scope === "FACILITY") {
    if (!args.facilityId) throw new BadRequestError("facilityId is required for FACILITY scope.");
    const fac = await prisma.facility.findUnique({ where: { id: args.facilityId }, select: { organizationId: true } });
    if (!fac) throw new NotFoundError();
    // Cross-tenant injection guard: the facility must belong to the stated org.
    if (fac.organizationId !== args.organizationId) throw new NotFoundError();
    return { scopeRef: args.facilityId, organizationId: fac.organizationId, facilityId: args.facilityId, departmentId: null };
  }
  // DEPARTMENT
  if (!args.departmentId) throw new BadRequestError("departmentId is required for DEPARTMENT scope.");
  const dept = await prisma.department.findUnique({ where: { id: args.departmentId }, select: { facilityId: true } });
  if (!dept) throw new NotFoundError();
  const fac = await prisma.facility.findUnique({ where: { id: dept.facilityId }, select: { organizationId: true } });
  if (!fac) throw new NotFoundError();
  if (fac.organizationId !== args.organizationId) throw new NotFoundError();
  if (args.facilityId && args.facilityId !== dept.facilityId) throw new BadRequestError("Department does not belong to that facility.");
  return { scopeRef: args.departmentId, organizationId: fac.organizationId, facilityId: dept.facilityId, departmentId: args.departmentId };
}

/** READ access to a scope: membership/standing (404-shaped for outsiders). */
export async function assertCanReadScope(m: ActorMemberships, args: ScopeArgs): Promise<void> {
  if (args.scope === "ORGANIZATION") { assertOrganizationAccess(m, args.organizationId); return; }
  const facilityId = args.scope === "FACILITY" ? args.facilityId! : (await deptFacility(args.departmentId!));
  const fac = await prisma.facility.findUnique({ where: { id: facilityId }, select: { organizationId: true } });
  if (!fac || !canAccessFacility(m, facilityId, fac.organizationId)) throw new NotFoundError();
}

/** WRITE access to a scope + key: admin standing, and platform-only keys stay platform. */
export async function assertCanConfigureScope(m: ActorMemberships, args: ScopeArgs, spec: KeySpec): Promise<void> {
  if (spec.platformOnly && !m.isPlatformAdmin) throw new ForbiddenError("configuration:operate");
  if (!spec.scopes.includes(args.scope)) throw new BadRequestError(`This key cannot be set at ${args.scope} scope.`);
  if (args.scope === "ORGANIZATION") { assertOrganizationAdmin(m, args.organizationId); return; }
  const facilityId = args.scope === "FACILITY" ? args.facilityId! : (await deptFacility(args.departmentId!));
  await assertFacilityAdmin(m, facilityId); // org admin or facility admin or platform
}

async function deptFacility(departmentId: string): Promise<string> {
  const dept = await prisma.department.findUnique({ where: { id: departmentId }, select: { facilityId: true } });
  if (!dept) throw new NotFoundError();
  return dept.facilityId;
}
