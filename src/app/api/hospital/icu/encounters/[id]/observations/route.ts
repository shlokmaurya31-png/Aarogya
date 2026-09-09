import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordObservation } from "@/lib/hospital/icu";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
    const type = searchParams.get("type") ?? undefined;
    const observations = await prisma.icuObservation.findMany({
      where: { encounterId: id, ...(type ? { type } : {}) },
      orderBy: { recordedAt: "desc" },
      take: 100,
    });
    return { observations };
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("icu:flowsheet:record", body?.facilityId);
    if (!staff) throw new BadRequestError("Observations must be recorded by a staff account.");
    if (!body?.type || body?.values === undefined) throw new BadRequestError("type and values are required.");

    const observation = await recordObservation({
      encounterId: id,
      facilityId,
      type: body.type,
      values: body.values,
      recordedByStaffId: staff.id,
      byUserId: session.userId,
    });
    return { observation };
  });
}
