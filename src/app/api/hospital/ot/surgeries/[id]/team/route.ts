import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { setTeamMember } from "@/lib/hospital/surgery";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const surgery = await prisma.surgery.findUnique({ where: { id } });
    if (!surgery || surgery.facilityId !== facilityId) throw new NotFoundError("Surgery not found.");
    const team = await prisma.surgeryTeamMember.findMany({ where: { surgeryId: id } });
    return { team };
  });
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { facilityId, staff } = await requireFacilityStaff("ot:procedure:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Must be performed by a staff account.");
    if (!body?.staffId || !body?.role) throw new BadRequestError("staffId and role are required.");
    const member = await setTeamMember({ surgeryId: id, facilityId, staffId: body.staffId, role: body.role, byUserId: staff.userId });
    return { member };
  });
}
