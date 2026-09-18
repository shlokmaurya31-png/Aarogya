import { ForbiddenError, NotFoundError } from "@/lib/auth/rbac";
import { assertOrganizationAccess, type ActorMemberships } from "@/lib/auth/tenantContext";

/**
 * Phase D7 — workflow authorization (§22). Reuses C4/D1, no parallel RBAC.
 *
 * Authoring (create/version/publish/retire) and operating (cancel/retry/recover,
 * engine ticks) are PLATFORM-only. Reads are tenant-scoped: a platform admin sees
 * everything; an org admin sees only global (platform) definitions and its OWN
 * organization's definitions/instances.
 */
export function requireWorkflowPlatform(m: ActorMemberships): void {
  if (!m.isPlatformAdmin) throw new ForbiddenError("workflow:manage");
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
