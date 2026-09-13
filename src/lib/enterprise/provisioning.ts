import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError, ForbiddenError } from "@/lib/auth/rbac";
import type { ActorMemberships } from "@/lib/auth/tenantContext";

/**
 * Phase D1 — enterprise provisioning.
 *
 * Provisioning creates a whole tenant structure atomically:
 *   organization → facility → administrator memberships → departments → ACTIVATE
 *
 * The whole thing runs in ONE transaction, so a failure never leaves a
 * half-provisioned tenant. It is idempotent by slug: re-running with the same
 * organization/facility slugs reuses the existing rows (upsert) rather than
 * duplicating them, so a retried request is safe. It is platform-only —
 * creating tenants is platform operation, not organization administration.
 */

export interface ProvisionInput {
  organization: { name: string; slug: string; legalName?: string | null };
  facility: { name: string; slug: string; city?: string | null };
  /** The user who becomes the organization + facility administrator. */
  adminUserId: string;
  /** Department names to create under the new facility. */
  departments?: string[];
}

export async function provisionOrganization(m: ActorMemberships, input: ProvisionInput) {
  if (!m.isPlatformAdmin) throw new ForbiddenError("enterprise:platform:manage");

  const orgSlug = input.organization.slug.trim();
  const facSlug = input.facility.slug.trim();
  const orgName = input.organization.name.trim();
  const facName = input.facility.name.trim();
  if (!orgSlug || !facSlug || !orgName || !facName) {
    throw new BadRequestError("Organization and facility name and slug are all required.");
  }

  const adminUser = await prisma.user.findUnique({ where: { id: input.adminUserId }, select: { id: true } });
  if (!adminUser) throw new BadRequestError("Administrator user does not exist.");

  await recordAuditEvent("enterprise.provisioning.started", m.userId, { orgSlug, facSlug });

  try {
    const result = await prisma.$transaction(async (tx) => {
      // 1. Organization (idempotent by slug).
      const org = await tx.organization.upsert({
        where: { slug: orgSlug },
        update: {},
        create: { slug: orgSlug, name: orgName, legalName: input.organization.legalName?.trim() || null, status: "ACTIVE" },
      });

      // 2. Facility (idempotent by org+slug), created PROVISIONING.
      const facility = await tx.facility.upsert({
        where: { organizationId_slug: { organizationId: org.id, slug: facSlug } },
        update: {},
        create: { organizationId: org.id, slug: facSlug, name: facName, city: input.facility.city?.trim() || null, status: "PROVISIONING" },
      });

      // 3. Administrator memberships (idempotent by unique user+scope).
      await tx.organizationMembership.upsert({
        where: { userId_organizationId: { userId: input.adminUserId, organizationId: org.id } },
        update: { isAdmin: true, status: "ACTIVE" },
        create: { userId: input.adminUserId, organizationId: org.id, isAdmin: true, createdByUserId: m.userId },
      });
      await tx.facilityMembership.upsert({
        where: { userId_facilityId: { userId: input.adminUserId, facilityId: facility.id } },
        update: { isAdmin: true, status: "ACTIVE" },
        create: { userId: input.adminUserId, facilityId: facility.id, isAdmin: true, createdByUserId: m.userId },
      });

      // 4. Departments (idempotent by facility+name).
      for (const name of input.departments ?? []) {
        const deptName = name.trim();
        if (!deptName) continue;
        await tx.department.upsert({
          where: { facilityId_name: { facilityId: facility.id, name: deptName } },
          update: {},
          create: { facilityId: facility.id, name: deptName },
        });
      }

      // 5. Activate.
      const activated = await tx.facility.update({ where: { id: facility.id }, data: { status: "ACTIVE" } });
      return { organization: org, facility: activated };
    });

    await recordAuditEvent(
      "enterprise.provisioning.completed",
      m.userId,
      { orgSlug, facSlug, adminUserId: input.adminUserId },
      { organizationId: result.organization.id, facilityId: result.facility.id }
    );
    return result;
  } catch (err) {
    await recordAuditEvent("enterprise.provisioning.failed", m.userId, {
      orgSlug,
      facSlug,
      error: err instanceof Error ? err.message : "unknown",
    });
    throw err;
  }
}
