import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordDevice } from "@/lib/hospital/icu";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
    const devices = await prisma.icuDevice.findMany({ where: { encounterId: id }, orderBy: { createdAt: "desc" } });
    return { devices };
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("icu:device:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Devices must be recorded by a staff account.");
    if (!body?.deviceType) throw new BadRequestError("deviceType is required.");

    const device = await recordDevice({
      encounterId: id,
      facilityId,
      deviceType: body.deviceType,
      site: body.site,
      status: body.status,
      insertedAt: body.insertedAt ? new Date(body.insertedAt) : undefined,
      notes: body.notes,
      recordedByStaffId: staff.id,
      byUserId: session.userId,
    });
    return { device };
  });
}
