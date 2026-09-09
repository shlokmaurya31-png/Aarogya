import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { buildBloodTimeline } from "@/lib/hospital/blood";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const request = await prisma.bloodRequest.findUnique({ where: { id }, select: { facilityId: true } });
    if (!request || request.facilityId !== facilityId) throw new NotFoundError("Blood request not found.");
    return { timeline: await buildBloodTimeline(id) };
  });
}
