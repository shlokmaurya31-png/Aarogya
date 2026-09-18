import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { listEvents } from "@/lib/events";

/** GET: platform-only list of domain events with operational filters. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("platform:events:operate");
    const sp = new URL(req.url).searchParams;
    const from = sp.get("from");
    const to = sp.get("to");
    return {
      events: await listEvents(m, {
        status: sp.get("status") ?? undefined,
        eventType: sp.get("eventType") ?? undefined,
        organizationId: sp.get("organizationId") ?? undefined,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
        limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
      }),
    };
  });
}
