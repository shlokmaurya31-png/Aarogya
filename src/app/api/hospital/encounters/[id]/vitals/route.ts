import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { findAbnormalVitals } from "@/lib/hospital/vitalsThresholds";

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
        consciousness: body?.consciousness,
        o2DeliveryMethod: body?.o2DeliveryMethod,
        o2FlowRate: body?.o2FlowRate,
      },
    });

    await recordAuditEvent("hospital.vital.recorded", session.userId, { encounterId: id, vitalId: vital.id });

    // Abnormal-vital detection ONLY against facility-configured thresholds (brief §13) — never a hardcoded clinical claim.
    const abnormal = await findAbnormalVitals(facilityId, { hr: vital.hr, sbp: vital.sbp, dbp: vital.dbp, rr: vital.rr, spo2: vital.spo2, tempC: vital.tempC });
    if (abnormal.length > 0) {
      await recordAuditEvent("hospital.vital.abnormalDetected", session.userId, { encounterId: id, vitalId: vital.id, abnormal });
    }

    return { vital, abnormal };
  });
}
