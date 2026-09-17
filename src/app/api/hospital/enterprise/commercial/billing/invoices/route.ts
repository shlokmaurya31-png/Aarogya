import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { listInvoices } from "@/lib/billing/invoices";

/** Tenant-scoped list of an organization's SaaS invoices. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:read");
    const organizationId = req.nextUrl.searchParams.get("organizationId");
    if (!organizationId) throw new BadRequestError("organizationId is required.");
    return { invoices: await listInvoices(m, organizationId) };
  });
}
