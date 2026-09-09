import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { getTransfusionWorkspace } from "@/lib/hospital/blood";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const workspace = await getTransfusionWorkspace(id);
    // Facility-scope the workspace server-side (never trust the URL id alone).
    if (workspace.request.facilityId !== facilityId) throw new NotFoundError("Blood request not found.");
    return { workspace };
  });
}
