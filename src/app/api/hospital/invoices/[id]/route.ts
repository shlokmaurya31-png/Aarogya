import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { findInvoiceInFacility } from "@/lib/hospital/billing/invoices";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("billing:view", searchParams.get("facilityId") ?? undefined);

    const invoice = await findInvoiceInFacility(id, facilityId);
    return { invoice };
  });
}
