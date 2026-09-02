import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const locations = await prisma.encounterLocation.findMany({ where: { encounterId: id }, include: { bed: { include: { ward: true } } }, orderBy: { assignedAt: "desc" } });
    return { locations, current: locations.find((l) => !l.releasedAt) ?? null };
  });
}

const LocationSchema = z.object({ bedId: z.string().optional(), areaLabel: z.string().optional(), facilityId: z.string().optional() });

/** Assigns (or moves) a patient's physical location — reuses Bed for a real bed resource, free-text areaLabel otherwise (brief §21/§33). Does NOT touch Bed.status/occupancy — that's Admission's job. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("encounter:assign", body?.facilityId);
    const parsed = LocationSchema.safeParse(body);
    if (!parsed.success || (!parsed.data.bedId && !parsed.data.areaLabel)) throw new BadRequestError("bedId or areaLabel is required.");

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const location = await prisma.$transaction(async (tx) => {
      await tx.encounterLocation.updateMany({ where: { encounterId: id, releasedAt: null }, data: { releasedAt: new Date() } });
      return tx.encounterLocation.create({
        data: { encounterId: id, facilityId, bedId: parsed.data.bedId, areaLabel: parsed.data.areaLabel, assignedByStaffId: staff?.id },
      });
    });

    await recordAuditEvent("hospital.location.assigned", session.userId, { encounterId: id, bedId: parsed.data.bedId, areaLabel: parsed.data.areaLabel });
    return { location };
  });
}
