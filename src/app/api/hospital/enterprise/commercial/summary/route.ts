import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getCommercialSummary } from "@/lib/commercial/summary";

/**
 * Phase D2 — the commercial state of an organization the caller can see. The
 * organizationId is validated against D1 membership inside getCommercialSummary
 * (assertOrganizationAccess), so a caller can never read another tenant's
 * commercial state by changing the id.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const organizationId = searchParams.get("organizationId");
    if (!organizationId) throw new BadRequestError("organizationId is required.");
    const m = await requireActorMemberships("commercial:read");
    return await getCommercialSummary(m, organizationId);
  });
}
