import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("vital:record", body?.facilityId);

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const vital = await prisma.vital.create({
      data: {
        encounterId: id,
        recordedByStaffId: staff?.id ?? session.userId,
        hr: body?.hr,
        sbp: body?.sbp,
        dbp: body?.dbp,
        rr: body?.rr,
        spo2: body?.spo2,
        tempC: body?.tempC,
        painScore: body?.painScore,
      },
    });

    await recordAuditEvent("hospital.vital.recorded", session.userId, { encounterId: id, vitalId: vital.id });
    return { vital };
  });
}
