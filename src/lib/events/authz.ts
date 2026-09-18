import { ForbiddenError } from "@/lib/auth/rbac";
import { assertOrganizationAccess, type ActorMemberships } from "@/lib/auth/tenantContext";

/**
 * Phase D6 — event-operations authorization.
 *
 * Domain events are an internal platform concern. Inspecting the operational
 * stream, dead letters, metrics, and — above all — REPLAY are PLATFORM-only.
 * An organization administrator can never replay events or read the cross-tenant
 * stream. A tenant may read only its OWN events, via the org-scoped path, and
 * only their operational metadata (never another tenant's, never as a data API).
 */
export function requirePlatformEvents(m: ActorMemberships): void {
  if (!m.isPlatformAdmin) throw new ForbiddenError("platform:events:operate");
}

/** Tenant-scoped read of an organization's own events. */
export function requireOrganizationEvents(m: ActorMemberships, organizationId: string): void {
  assertOrganizationAccess(m, organizationId);
}
