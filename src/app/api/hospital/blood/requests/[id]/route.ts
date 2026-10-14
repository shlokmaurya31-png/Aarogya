import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { getTransfusionWorkspace } from "@/lib/hospital/blood";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    // Ownership first: an unknown ID and another facility's ID both get the
    // same 404, and another facility's workspace is never loaded at all.
    const owner = await prisma.bloodRequest.findUnique({ where: { id }, select: { facilityId: true } });
    if (!owner || owner.facilityId !== facilityId) throw new NotFoundError("Blood request not found.");
    const workspace = await getTransfusionWorkspace(id);
    return { workspace };
  });
}
