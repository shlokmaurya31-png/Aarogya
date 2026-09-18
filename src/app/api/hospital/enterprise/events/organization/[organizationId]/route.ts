import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { listOrganizationEvents } from "@/lib/events";

/**
 * GET: tenant-scoped list of an organization's OWN events (operational metadata +
 * safe payload). Gated by commercial:read + D1 membership — an org admin sees only
 * their own tenant's events, never another's, and this is not a clinical data API.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ organizationId: string }> }) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:read");
    const { organizationId } = await params;
    const sp = new URL(req.url).searchParams;
    return {
      events: await listOrganizationEvents(m, organizationId, {
        status: sp.get("status") ?? undefined,
        eventType: sp.get("eventType") ?? undefined,
        limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
      }),
    };
  });
}
