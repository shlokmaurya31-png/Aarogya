import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError, ForbiddenError } from "@/lib/auth/rbac";
import {
  type ActorMemberships,
  assertOrganizationAccess,
  assertOrganizationAdmin,
  TenantAccessError,
} from "@/lib/auth/tenantContext";
import { findOrganizationTransition } from "./constants";
import type { OrganizationStatus } from "@prisma/client";

/**
 * Phase D1 — organization lifecycle service.
 *
 * Every mutation is authorized against the caller's membership (never their
 * role alone), audited with the organization scope, and — for lifecycle — only
 * permitted along a declared transition. Deactivation never deletes data.
 */

function requirePlatform(m: ActorMemberships) {
  if (!m.isPlatformAdmin) throw new ForbiddenError("enterprise:platform:manage");
}

export async function createOrganization(
  m: ActorMemberships,
  input: { name: string; slug?: string | null; legalName?: string | null }
) {
  // Creating a tenant is platform operation, not organization administration.
  requirePlatform(m);
  const name = input.name.trim();
  if (!name) throw new BadRequestError("Organization name is required.");
  const slug = input.slug?.trim() || null;

  if (slug) {
    const existing = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
    if (existing) throw new BadRequestError("An organization with this slug already exists.");
  }

  const org = await prisma.organization.create({
    data: { name, slug, legalName: input.legalName?.trim() || null, status: "ACTIVE" },
  });
  await recordAuditEvent("enterprise.organization.created", m.userId, { name, slug }, { organizationId: org.id });
  return org;
}

export async function updateOrganization(
  m: ActorMemberships,
  organizationId: string,
  input: { name?: string; legalName?: string | null }
) {
  assertOrganizationAdmin(m, organizationId);
  const data: { name?: string; legalName?: string | null } = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new BadRequestError("Organization name cannot be empty.");
    data.name = name;
  }
  if (input.legalName !== undefined) data.legalName = input.legalName?.trim() || null;

  const org = await prisma.organization.update({ where: { id: organizationId }, data });
  await recordAuditEvent("enterprise.organization.updated", m.userId, { changed: Object.keys(data) }, { organizationId });
  return org;
}

const TRANSITION_EVENT: Record<OrganizationStatus, "enterprise.organization.suspended" | "enterprise.organization.reactivated" | "enterprise.organization.deactivated"> = {
  ACTIVE: "enterprise.organization.reactivated",
  SUSPENDED: "enterprise.organization.suspended",
  DEACTIVATED: "enterprise.organization.deactivated",
};

export async function transitionOrganization(
  m: ActorMemberships,
  organizationId: string,
  to: OrganizationStatus,
  reason?: string
) {
  // Lifecycle is organization administration; suspend/deactivate/reactivate are
  // all org-admin (or platform) actions.
  assertOrganizationAdmin(m, organizationId);
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { status: true } });
  if (!org) throw new BadRequestError("Organization not found.");
  if (org.status === to) throw new BadRequestError(`Organization is already ${to}.`);

  const transition = findOrganizationTransition(org.status, to);
  if (!transition) throw new BadRequestError(`Cannot move an organization from ${org.status} to ${to}.`);
  if (transition.platformOnly && !m.isPlatformAdmin) {
    throw new TenantAccessError("Reactivating a deactivated organization requires the platform administrator.");
  }

  const now = new Date();
  const updated = await prisma.organization.update({
    where: { id: organizationId },
    data: {
      status: to,
      suspendedAt: to === "SUSPENDED" ? now : undefined,
      deactivatedAt: to === "DEACTIVATED" ? now : undefined,
    },
  });
  await recordAuditEvent(TRANSITION_EVENT[to], m.userId, { from: org.status, to, reason: reason ?? null }, { organizationId });
  return updated;
}

/** Organizations the caller can see: theirs (member) or all (platform). */
export async function listOrganizationsForActor(m: ActorMemberships) {
  if (m.isPlatformAdmin) {
    return prisma.organization.findMany({ orderBy: { createdAt: "asc" } });
  }
  const ids = [...m.orgMemberships.keys()];
  if (ids.length === 0) return [];
  return prisma.organization.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: "asc" } });
}

/** A single organization the caller has standing in, with its facilities. */
export async function getOrganizationForActor(m: ActorMemberships, organizationId: string) {
  assertOrganizationAccess(m, organizationId);
  return prisma.organization.findUnique({
    where: { id: organizationId },
    include: {
      facilities: { orderBy: { createdAt: "asc" }, select: { id: true, name: true, slug: true, city: true, status: true } },
    },
  });
}
