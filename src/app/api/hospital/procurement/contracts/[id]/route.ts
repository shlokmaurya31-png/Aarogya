import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { deactivateSupplierContract } from "@/lib/hospital/procurement/procurementAdvanced";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { session, facilityId } = await requireFacilityStaff("procurement:contract:manage", searchParams.get("facilityId") ?? undefined);
    return { contract: await deactivateSupplierContract({ contractId: id, facilityId, byUserId: session.userId }) };
  });
}
