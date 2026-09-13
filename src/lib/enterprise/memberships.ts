import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError } from "@/lib/auth/rbac";
import {
  type ActorMemberships,
  assertOrganizationAdmin,
  assertFacilityAdmin,
  TenantAccessError,
} from "@/lib/auth/tenantContext";
import { enforceLimit } from "@/lib/commercial/limits";

/**
 * Phase D1 — membership service.
 *
 * The two invariants this file exists to protect, beyond the schema's unique
 * constraints (which stop duplicate-membership races producing two rows):
 *
 *   SELF-GRANT       a caller may never grant or elevate THEIR OWN membership
 *                    to administrator. Elevation is always someone else's act.
 *   ESCALATION       organization administration can only be granted by an
 *                    organization administrator (or platform); a facility
 *                    administrator cannot mint an organization administrator,
 *                    because assertOrganizationAdmin refuses them first.
 *
 * Removal is a hard delete (auditable). Demoting/removing the LAST active
 * organization administrator is refused so a tenant cannot be orphaned.
 */

function isUnique(err: unknown): boolean {
  return !!err && typeof err === "object" && (err as { code?: string }).code === "P2002";
}

async function requireUserExists(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new BadRequestError("No such user.");
}

// ── Organization membership ────────────────────────────────────────────────

export async function addOrganizationMembership(
  m: ActorMemberships,
  input: { organizationId: string; userId: string; isAdmin: boolean }
) {
  assertOrganizationAdmin(m, input.organizationId);
  await requireUserExists(input.userId);

  // Self-grant guard: a caller cannot make themselves an administrator.
  if (input.userId === m.userId && input.isAdmin && !m.isPlatformAdmin) {
    throw new TenantAccessError("You cannot grant yourself organization administration.");
  }

  try {
    // Phase D2 — enforce the max_users limit race-safely. Only ORGANIZATION
    // membership counts toward the user limit (a facility membership for an
    // existing org member adds no new user).
    const created = await enforceLimit({
      organizationId: input.organizationId,
      key: "max_users",
      actorUserId: m.userId,
      count: (tx) => tx.organizationMembership.count({ where: { organizationId: input.organizationId, status: "ACTIVE" } }),
      create: (tx) => tx.organizationMembership.create({
        data: { organizationId: input.organizationId, userId: input.userId, isAdmin: input.isAdmin, createdByUserId: m.userId },
      }),
    });
    await recordAuditEvent(
      "enterprise.membership.created",
      m.userId,
      { scope: "organization", targetUserId: input.userId, isAdmin: input.isAdmin },
      { organizationId: input.organizationId }
    );
    return created;
  } catch (err) {
    if (isUnique(err)) throw new BadRequestError("User is already a member of this organization; update the membership instead.");
    throw err;
  }
}

export async function addFacilityMembership(
  m: ActorMemberships,
  input: { facilityId: string; userId: string; isAdmin: boolean }
) {
  const { organizationId } = await assertFacilityAdmin(m, input.facilityId);
  await requireUserExists(input.userId);

  if (input.userId === m.userId && input.isAdmin && !m.isPlatformAdmin) {
    throw new TenantAccessError("You cannot grant yourself facility administration.");
  }

  try {
    const created = await prisma.facilityMembership.create({
      data: {
        facilityId: input.facilityId,
        userId: input.userId,
        isAdmin: input.isAdmin,
        createdByUserId: m.userId,
      },
    });
    await recordAuditEvent(
      "enterprise.membership.created",
      m.userId,
      { scope: "facility", targetUserId: input.userId, isAdmin: input.isAdmin },
      { organizationId, facilityId: input.facilityId }
    );
    return created;
  } catch (err) {
    if (isUnique(err)) throw new BadRequestError("User is already a member of this facility; update the membership instead.");
    throw err;
  }
}

// ── Scope change ─────────────────────────────────────────────────────────────

async function assertNotLastOrgAdmin(organizationId: string, membershipId: string) {
  const adminCount = await prisma.organizationMembership.count({
    where: { organizationId, isAdmin: true, status: "ACTIVE", id: { not: membershipId } },
  });
  if (adminCount === 0) throw new BadRequestError("This is the last organization administrator; assign another before changing it.");
}

export async function setOrganizationMembershipScope(
  m: ActorMemberships,
  membershipId: string,
  changes: { isAdmin?: boolean; status?: "ACTIVE" | "SUSPENDED" }
) {
  const membership = await prisma.organizationMembership.findUnique({ where: { id: membershipId } });
  if (!membership) throw new BadRequestError("Membership not found.");
  assertOrganizationAdmin(m, membership.organizationId);

  // Self-grant guard: cannot elevate own membership.
  if (membership.userId === m.userId && changes.isAdmin === true && !m.isPlatformAdmin) {
    throw new TenantAccessError("You cannot grant yourself organization administration.");
  }
  // Last-admin guard when demoting or suspending an admin.
  const losingAdmin = (changes.isAdmin === false || changes.status === "SUSPENDED") && membership.isAdmin && membership.status === "ACTIVE";
  if (losingAdmin) await assertNotLastOrgAdmin(membership.organizationId, membershipId);

  const updated = await prisma.organizationMembership.update({
    where: { id: membershipId },
    data: { isAdmin: changes.isAdmin, status: changes.status },
  });
  await recordAuditEvent(
    "enterprise.membership.scopeChanged",
    m.userId,
    { scope: "organization", membershipId, changes },
    { organizationId: membership.organizationId }
  );
  return updated;
}

export async function setFacilityMembershipScope(
  m: ActorMemberships,
  membershipId: string,
  changes: { isAdmin?: boolean; status?: "ACTIVE" | "SUSPENDED" }
) {
  const membership = await prisma.facilityMembership.findUnique({
    where: { id: membershipId },
    include: { facility: { select: { organizationId: true } } },
  });
  if (!membership) throw new BadRequestError("Membership not found.");
  await assertFacilityAdmin(m, membership.facilityId);

  if (membership.userId === m.userId && changes.isAdmin === true && !m.isPlatformAdmin) {
    throw new TenantAccessError("You cannot grant yourself facility administration.");
  }

  const updated = await prisma.facilityMembership.update({
    where: { id: membershipId },
    data: { isAdmin: changes.isAdmin, status: changes.status },
  });
  await recordAuditEvent(
    "enterprise.membership.scopeChanged",
    m.userId,
    { scope: "facility", membershipId, changes },
    { organizationId: membership.facility.organizationId, facilityId: membership.facilityId }
  );
  return updated;
}

// ── Removal ──────────────────────────────────────────────────────────────────

export async function removeOrganizationMembership(m: ActorMemberships, membershipId: string) {
  const membership = await prisma.organizationMembership.findUnique({ where: { id: membershipId } });
  if (!membership) throw new BadRequestError("Membership not found.");
  assertOrganizationAdmin(m, membership.organizationId);
  if (membership.isAdmin && membership.status === "ACTIVE") {
    await assertNotLastOrgAdmin(membership.organizationId, membershipId);
  }
  await prisma.organizationMembership.delete({ where: { id: membershipId } });
  await recordAuditEvent(
    "enterprise.membership.removed",
    m.userId,
    { scope: "organization", targetUserId: membership.userId },
    { organizationId: membership.organizationId }
  );
}

export async function removeFacilityMembership(m: ActorMemberships, membershipId: string) {
  const membership = await prisma.facilityMembership.findUnique({
    where: { id: membershipId },
    include: { facility: { select: { organizationId: true } } },
  });
  if (!membership) throw new BadRequestError("Membership not found.");
  await assertFacilityAdmin(m, membership.facilityId);
  await prisma.facilityMembership.delete({ where: { id: membershipId } });
  await recordAuditEvent(
    "enterprise.membership.removed",
    m.userId,
    { scope: "facility", targetUserId: membership.userId },
    { organizationId: membership.facility.organizationId, facilityId: membership.facilityId }
  );
}

// ── Read ─────────────────────────────────────────────────────────────────────

export async function listOrganizationMembers(m: ActorMemberships, organizationId: string) {
  assertOrganizationAdmin(m, organizationId);
  return prisma.organizationMembership.findMany({
    where: { organizationId },
    include: { user: { select: { id: true, displayName: true, email: true, role: true } } },
    orderBy: { createdAt: "asc" },
  });
}

export async function listFacilityMembers(m: ActorMemberships, facilityId: string) {
  await assertFacilityAdmin(m, facilityId);
  return prisma.facilityMembership.findMany({
    where: { facilityId },
    include: { user: { select: { id: true, displayName: true, email: true, role: true } } },
    orderBy: { createdAt: "asc" },
  });
}
