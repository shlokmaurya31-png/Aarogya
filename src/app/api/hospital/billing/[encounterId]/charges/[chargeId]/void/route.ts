import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { voidCharge } from "@/lib/hospital/billing/chargeCapture";

export async function POST(req: NextRequest, { params }: { params: Promise<{ encounterId: string; chargeId: string }> }) {
  return withApiErrors(async () => {
    const { encounterId, chargeId } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:charge:void", body?.facilityId);

    const { reason } = body ?? {};
    if (!reason || typeof reason !== "string") throw new BadRequestError("A void reason is required.");

    const charge = await prisma.charge.findUnique({ where: { id: chargeId } });
    if (!charge || charge.facilityId !== facilityId || charge.encounterId !== encounterId) throw new NotFoundError("Charge not found.");

    const updated = await prisma.$transaction((tx) => voidCharge(tx, chargeId, { reason, byUserId: session.userId }));

    await recordAuditEvent(
      "hospital.billing.chargeVoided",
      session.userId,
      { chargeId, reason },
      { facilityId, patientId: charge.patientId, encounterId }
    );
    return { charge: updated };
  });
}
