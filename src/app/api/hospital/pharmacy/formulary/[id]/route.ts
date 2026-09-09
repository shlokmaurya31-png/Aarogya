import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { deactivateFormularyEntry } from "@/lib/hospital/pharmacy";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { session, facilityId } = await requireFacilityStaff("pharmacy:formulary:manage", searchParams.get("facilityId") ?? undefined);
    return { entry: await deactivateFormularyEntry({ formularyEntryId: id, facilityId, byUserId: session.userId }) };
  });
}
