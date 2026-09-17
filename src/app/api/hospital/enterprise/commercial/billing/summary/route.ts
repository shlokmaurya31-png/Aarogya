import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { getBillingSummary } from "@/lib/billing/summary";

/** Tenant-scoped SaaS billing read model for the enterprise workspace. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:read");
    const organizationId = req.nextUrl.searchParams.get("organizationId");
    if (!organizationId) throw new BadRequestError("organizationId is required.");
    return getBillingSummary(m, organizationId);
  });
}
