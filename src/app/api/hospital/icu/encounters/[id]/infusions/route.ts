import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordInfusion } from "@/lib/hospital/icu";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
    const infusions = await prisma.icuInfusion.findMany({ where: { encounterId: id }, orderBy: { startedAt: "desc" } });
    return { infusions };
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("icu:infusion:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Infusions must be recorded by a staff account.");
    if (!body?.drugName) throw new BadRequestError("drugName is required.");

    const infusion = await recordInfusion({
      encounterId: id,
      facilityId,
      drugName: body.drugName,
      medicationOrderId: body.medicationOrderId,
      route: body.route,
      concentration: body.concentration,
      rate: body.rate !== undefined ? Number(body.rate) : undefined,
      rateUnit: body.rateUnit,
      prescriberStaffId: body.prescriberStaffId,
      recordedByStaffId: staff.id,
      byUserId: session.userId,
    });
    return { infusion };
  });
}
