import { NextRequest } from "next/server";
import { recordVitals } from "@/lib/hospital/clinicalRecords";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("vital:record", body?.facilityId);
    if (!staff) throw new BadRequestError("Vitals must be recorded by a staff account.");

    const { vital, abnormal } = await recordVitals({
      encounterId: id, facilityId, staffId: staff.id, byUserId: session.userId,
      vitals: { hr: body?.hr, sbp: body?.sbp, dbp: body?.dbp, rr: body?.rr, spo2: body?.spo2, tempC: body?.tempC, painScore: body?.painScore, consciousness: body?.consciousness, o2DeliveryMethod: body?.o2DeliveryMethod, o2FlowRate: body?.o2FlowRate },
    });
    const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id }, select: { patientId: true } });

    await recordAuditEvent(
      "hospital.vital.recorded",
      session.userId,
      { encounterId: id, vitalId: vital.id },
      { facilityId, patientId: encounter.patientId, encounterId: id }
    );

    // Abnormal-vital detection ONLY against facility-configured thresholds (brief §13) — never a hardcoded clinical claim.
    if (abnormal.length > 0) {
      await recordAuditEvent(
        "hospital.vital.abnormalDetected",
        session.userId,
        { encounterId: id, vitalId: vital.id, abnormal },
        { facilityId, patientId: encounter.patientId, encounterId: id }
      );
    }

    return { vital, abnormal };
  });
}
