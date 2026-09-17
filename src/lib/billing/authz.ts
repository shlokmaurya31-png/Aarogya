import { ForbiddenError } from "@/lib/auth/rbac";
import type { ActorMemberships } from "@/lib/auth/tenantContext";

/**
 * Phase D3 — privileged financial mutation is PLATFORM-only.
 *
 * Creating/finalizing/voiding invoices, recording payments, issuing refunds and
 * credits, mapping providers and processing webhooks are all commercial acts an
 * organization administrator can never perform on their own account (no
 * self-refund, no self-credit, no self-void). Reads are tenant-scoped separately
 * via assertOrganizationAccess. Mirrors D2's `commercial:platform:manage` rule.
 */
export function requirePlatform(m: ActorMemberships): void {
  if (!m.isPlatformAdmin) throw new ForbiddenError("commercial:platform:manage");
}
