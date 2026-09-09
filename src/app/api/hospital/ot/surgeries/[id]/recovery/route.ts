import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { updateRecovery } from "@/lib/hospital/surgery";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const surgery = await prisma.surgery.findUnique({ where: { id } });
    if (!surgery || surgery.facilityId !== facilityId) throw new NotFoundError("Surgery not found.");
    const recovery = await prisma.recoveryRecord.findUnique({ where: { surgeryId: id } });
    return { recovery };
  });
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("ot:recovery:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Must be performed by a staff account.");
    const recovery = await updateRecovery({ surgeryId: id, facilityId, status: body?.status, destination: body?.destination, responsibleStaffId: body?.responsibleStaffId, nurseStaffId: body?.nurseStaffId, notes: body?.notes, byUserId: session.userId });
    return { recovery };
  });
}
