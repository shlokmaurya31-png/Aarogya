import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { collectSpecimen } from "@/lib/hospital/surgery";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const surgery = await prisma.surgery.findUnique({ where: { id } });
    if (!surgery || surgery.facilityId !== facilityId) throw new NotFoundError("Surgery not found.");
    const specimens = await prisma.surgicalSpecimen.findMany({ where: { surgeryId: id }, orderBy: { collectedAt: "desc" } });
    return { specimens };
  });
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("ot:specimen:record", body?.facilityId);
    if (!staff) throw new BadRequestError("Must be performed by a staff account.");
    if (!body?.specimenType) throw new BadRequestError("specimenType is required.");
    const specimen = await collectSpecimen({ surgeryId: id, facilityId, specimenType: body.specimenType, site: body.site, label: body.label, destinationLab: body.destinationLab, collectedByStaffId: staff.id, notes: body.notes, byUserId: session.userId });
    return { specimen };
  });
}
