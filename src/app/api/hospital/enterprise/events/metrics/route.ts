import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getEventMetrics } from "@/lib/events";

/** GET: platform-only domain-event system metrics (event-system metrics, not business KPIs). */
export async function GET() {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("platform:events:operate");
    return getEventMetrics(m);
  });
}
