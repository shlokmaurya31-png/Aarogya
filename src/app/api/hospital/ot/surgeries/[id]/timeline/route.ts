import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { buildSurgeryTimeline } from "@/lib/hospital/surgery";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const surgery = await prisma.surgery.findUnique({ where: { id } });
    if (!surgery || surgery.facilityId !== facilityId) throw new NotFoundError("Surgery not found.");
    const entries = await buildSurgeryTimeline(id);
    return { entries };
  });
}
