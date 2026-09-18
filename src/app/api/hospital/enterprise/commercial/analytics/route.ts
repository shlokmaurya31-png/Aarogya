import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getRevenueOverview, getOrganizationAR, getAging } from "@/lib/commercial/analytics/revenueOps";
import { getPaymentFailureAnalytics } from "@/lib/commercial/analytics/failures";
import { getMrrArr, getLifecycleAnalytics } from "@/lib/commercial/analytics/subscriptions";

/**
 * Commercial analytics dispatcher. `commercial:read` is required; each service
 * then enforces platform-only (overview/mrr/lifecycle) or tenant scope (ar/aging/
 * failures with organizationId) — authorization happens before any resource
 * lookup. All figures are server-derived; periods are bounded server-side.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:read");
    const q = req.nextUrl.searchParams;
    const view = q.get("view");
    const organizationId = q.get("organizationId") ?? undefined;
    const fromISO = q.get("from") ?? undefined;
    const toISO = q.get("to") ?? undefined;
    switch (view) {
      case "overview": return getRevenueOverview(m, { fromISO, toISO });
      case "ar": {
        if (!organizationId) throw new BadRequestError("organizationId is required for the AR view.");
        return getOrganizationAR(m, organizationId);
      }
      case "aging": return getAging(m, { organizationId });
      case "failures": return getPaymentFailureAnalytics(m, { fromISO, toISO, organizationId });
      case "mrr": return getMrrArr(m);
      case "lifecycle": return getLifecycleAnalytics(m, { fromISO, toISO });
      default: throw new BadRequestError("Unknown analytics view.");
    }
  });
}
