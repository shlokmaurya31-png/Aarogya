import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { reviewSupplierInvoice } from "@/lib/hospital/procurement/procurementAdvanced";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("procurement:invoice:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Invoice review requires a procurement staff account.");
    if (body?.to !== "APPROVED" && body?.to !== "REJECTED") throw new BadRequestError("to must be APPROVED or REJECTED.");
    return { invoice: await reviewSupplierInvoice({ invoiceId: id, facilityId, to: body.to, reviewedByStaffId: staff.id, byUserId: session.userId }) };
  });
}
