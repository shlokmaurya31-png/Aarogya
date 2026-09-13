import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError } from "@/lib/auth/rbac";
import {
  type ActorMemberships,
  assertOrganizationAdmin,
  assertFacilityAdmin,
  TenantAccessError,
} from "@/lib/auth/tenantContext";
import { findFacilityTransition } from "./constants";
import { requireEntitlement, enforceLimit } from "@/lib/commercial/limits";
import type { FacilityStatus } from "@prisma/client";

/**
 * Phase D1 — facility lifecycle service. A facility always belongs to exactly
 * one organization; creating one is organization administration. New facilities
 * start PROVISIONING and must be explicitly activated (brief §14 lifecycle).
 */

export async function createFacility(
  m: ActorMemberships,
  organizationId: string,
  input: { name: string; slug?: string | null; city?: string | null }
) {
  assertOrganizationAdmin(m, organizationId);
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { status: true } });
  if (!org) throw new BadRequestError("Organization not found.");
  if (org.status !== "ACTIVE") throw new BadRequestError("Cannot create a facility under a non-active organization.");

  const name = input.name.trim();
  if (!name) throw new BadRequestError("Facility name is required.");
  const slug = input.slug?.trim() || null;
  if (slug) {
    const existing = await prisma.facility.findUnique({
      where: { organizationId_slug: { organizationId, slug } },
      select: { id: true },
    });
    if (existing) throw new BadRequestError("A facility with this slug already exists in this organization.");
  }

  // Phase D2 — commercial gates, layered AFTER the D1 tenant-admin check:
  //   (a) the organization must have the Hospital OS product entitlement, and
  //   (b) creation must stay within the plan's max_facilities limit, enforced
  //       race-safely (Serializable) so two concurrent creates cannot both pass
  //       a limit of N when N-1 exist.
  await requireEntitlement({ organizationId, key: "hospital_os" });
  const facility = await enforceLimit({
    organizationId,
    key: "max_facilities",
    actorUserId: m.userId,
    count: (tx) => tx.facility.count({ where: { organizationId, status: { not: "DEACTIVATED" } } }),
    create: (tx) => tx.facility.create({ data: { name, slug, city: input.city?.trim() || null, organizationId, status: "PROVISIONING" } }),
  });
  await recordAuditEvent(
    "enterprise.facility.created",
    m.userId,
    { name, slug, status: "PROVISIONING" },
    { organizationId, facilityId: facility.id }
  );
  return facility;
}

export async function updateFacility(
  m: ActorMemberships,
  facilityId: string,
  input: { name?: string; city?: string | null }
) {
  const { organizationId } = await assertFacilityAdmin(m, facilityId);
  const data: { name?: string; city?: string | null } = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new BadRequestError("Facility name cannot be empty.");
    data.name = name;
  }
  if (input.city !== undefined) data.city = input.city?.trim() || null;

  const facility = await prisma.facility.update({ where: { id: facilityId }, data });
  await recordAuditEvent("enterprise.facility.updated", m.userId, { changed: Object.keys(data) }, { organizationId, facilityId });
  return facility;
}

// PROVISIONING is only ever a start state — no declared transition targets it —
// so it needs no event mapping here.
const FACILITY_EVENT: Record<Exclude<FacilityStatus, "PROVISIONING">, "enterprise.facility.activated" | "enterprise.facility.suspended" | "enterprise.facility.deactivated"> = {
  ACTIVE: "enterprise.facility.activated",
  SUSPENDED: "enterprise.facility.suspended",
  DEACTIVATED: "enterprise.facility.deactivated",
};

export async function transitionFacility(
  m: ActorMemberships,
  facilityId: string,
  to: FacilityStatus,
  reason?: string
) {
  const { organizationId } = await assertFacilityAdmin(m, facilityId);
  const facility = await prisma.facility.findUnique({ where: { id: facilityId }, select: { status: true } });
  if (!facility) throw new BadRequestError("Facility not found.");
  if (facility.status === to) throw new BadRequestError(`Facility is already ${to}.`);

  const transition = findFacilityTransition(facility.status, to);
  if (!transition) throw new BadRequestError(`Cannot move a facility from ${facility.status} to ${to}.`);
  if (transition.platformOnly && !m.isPlatformAdmin) {
    throw new TenantAccessError("Reactivating a deactivated facility requires the platform administrator.");
  }

  const now = new Date();
  const updated = await prisma.facility.update({
    where: { id: facilityId },
    data: {
      status: to,
      suspendedAt: to === "SUSPENDED" ? now : undefined,
      deactivatedAt: to === "DEACTIVATED" ? now : undefined,
    },
  });
  // Reactivation from SUSPENDED is a distinct event from first activation.
  const event = facility.status === "SUSPENDED" && to === "ACTIVE"
    ? "enterprise.facility.reactivated"
    : FACILITY_EVENT[to as Exclude<FacilityStatus, "PROVISIONING">];
  await recordAuditEvent(event, m.userId, { from: facility.status, to, reason: reason ?? null }, { organizationId, facilityId });
  return updated;
}

/** Facilities under an organization that the caller can actually reach. */
export async function listFacilitiesForActor(m: ActorMemberships, organizationId: string) {
  const all = await prisma.facility.findMany({
    where: { organizationId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, slug: true, city: true, status: true, organizationId: true },
  });
  if (m.isPlatformAdmin || m.adminOrgIds.has(organizationId)) return all;
  return all.filter((f) => m.facilityMemberships.has(f.id));
}
