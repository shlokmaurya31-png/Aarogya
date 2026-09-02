import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import {
  verifyMedicationOrder, rejectMedicationOrder, holdMedicationOrder, requestClarification,
  InvalidMedicationOrderTransitionError,
} from "@/lib/hospital/medicationLifecycle";

/** Pharmacist verification queue actions (brief §17) — verify | reject | hold | clarify. Rejection/hold/clarify require a reason. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("medication:verify", body?.facilityId);
    if (!staff) throw new BadRequestError("Verification must be performed by a staff account.");

    const order = await prisma.medicationOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Medication order not found.");

    const decision = body?.decision as string | undefined;
    const reason = body?.reason as string | undefined;
    if (decision !== "VERIFIED" && !reason) throw new BadRequestError("reason is required for reject/hold/clarify.");

    try {
      if (decision === "VERIFIED") return { order: await verifyMedicationOrder(id, staff.id, session.userId) };
      if (decision === "REJECTED") return { order: await rejectMedicationOrder(id, reason!, staff.id, session.userId) };
      if (decision === "HOLD") return { order: await holdMedicationOrder(id, reason!, staff.id, session.userId) };
      if (decision === "CLARIFICATION_REQUESTED") return { order: await requestClarification(id, reason!, staff.id, session.userId) };
      throw new BadRequestError("decision must be one of VERIFIED, REJECTED, HOLD, CLARIFICATION_REQUESTED.");
    } catch (err) {
      if (err instanceof InvalidMedicationOrderTransitionError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
