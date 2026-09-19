import { ForbiddenError, NotFoundError } from "@/lib/auth/rbac";
import { assertOrganizationAccess, assertOrganizationAdmin, type ActorMemberships } from "@/lib/auth/tenantContext";

/**
 * Phase D7 — workflow authorization (§22). Reuses C4/D1, no parallel RBAC.
 *
 * OPERATING (cancel/retry/recover, engine ticks) is PLATFORM-only. Reads are
 * tenant-scoped: a platform admin sees everything; an org admin sees only global
 * (platform) definitions and its OWN organization's definitions/instances.
 *
 * AUTHORING (create/version/publish/retire) is scoped (extended in D9 so hospital
 * administrators can build workflows for their own organization): a GLOBAL template
 * (organizationId null) stays PLATFORM-only, while an ORG-scoped workflow may be
 * authored by an administrator of that organization (or the platform). Execution
 * (D7) and configuration governance (D8) are unchanged.
 */
export function requireWorkflowPlatform(m: ActorMemberships): void {
  if (!m.isPlatformAdmin) throw new ForbiddenError("workflow:manage");
}

/**
 * Authoring authorization for a workflow at a given tenant scope. Global templates
 * (organizationId null) are platform-only; an org-scoped workflow requires org
 * administration (assertOrganizationAdmin) or platform. This is the D9 seam that
 * lets a hospital administrator author workflows for their own organization without
 * granting cross-tenant or global authority.
 */
export function assertCanAuthorWorkflow(m: ActorMemberships, organizationId: string | null): void {
  if (m.isPlatformAdmin) return;
  if (organizationId === null) throw new ForbiddenError("workflow:manage"); // global templates are platform-only
  assertOrganizationAdmin(m, organizationId); // org admin of THIS org (404/403-shaped)
}

/**
 * A caller may READ a workflow record with the given tenant owner. `null`
 * organizationId means a global platform template, readable by any workflow reader.
 * An org-scoped record is readable only by the platform or a member of that org.
 */
export function assertCanReadWorkflowScope(m: ActorMemberships, organizationId: string | null): void {
  if (m.isPlatformAdmin) return;
  if (organizationId === null) return; // global template
  assertOrganizationAccess(m, organizationId); // 404-shaped for outsiders
}

/** A tenant-scoped list request must target an org the caller can access. */
export function assertOrganizationReadable(m: ActorMemberships, organizationId: string): void {
  assertOrganizationAccess(m, organizationId);
}

export { NotFoundError };
