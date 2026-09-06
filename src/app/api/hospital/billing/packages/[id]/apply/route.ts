import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { applyPackageToEncounter } from "@/lib/hospital/billing/packages";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:invoice:create", body?.facilityId);

    const { encounterId } = body ?? {};
    if (!encounterId) throw new BadRequestError("encounterId is required.");

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const { charge, alreadyExisted } = await prisma.$transaction((tx) =>
      applyPackageToEncounter(tx, { packageId: id, encounterId, patientId: encounter.patientId, facilityId, postedByUserId: session.userId })
    );

    if (!alreadyExisted) {
      await recordAuditEvent(
        "hospital.billing.packageApplied",
        session.userId,
        { packageId: id, chargeId: charge.id },
        { facilityId, patientId: encounter.patientId, encounterId }
      );
    }
    return { charge, alreadyExisted };
  });
}
