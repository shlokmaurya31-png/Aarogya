import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError, ForbiddenError } from "@/lib/auth/rbac";
import type { Permission } from "@/lib/auth/permissions";
import {
  cancelMedicationOrder, discontinueMedicationOrder, resubmitMedicationOrder,
  InvalidMedicationOrderTransitionError,
} from "@/lib/hospital/medicationLifecycle";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const order = await prisma.medicationOrder.findUnique({
      where: { id },
      include: {
        patient: true, encounter: true, orderedBy: { include: { user: true } },
        administrations: true, safetyWarnings: true, verifications: { include: { pharmacist: { include: { user: true } } } }, dispensingRecords: true,
      },
    });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Medication order not found.");
    return { order };
  });
}

const PERMISSION_FOR_ACTION: Record<string, Permission> = {
  cancel: "clinical:order:medication",
  discontinue: "medication:discontinue",
  resubmit: "clinical:order:medication",
};

/** Medication order lifecycle actions (brief §16) — cancel | discontinue | resubmit. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const action = body?.action as string | undefined;
    const permission = PERMISSION_FOR_ACTION[action ?? ""];
    if (!permission) throw new BadRequestError("Unknown or missing action.");

    const { session, facilityId, staff } = await requireFacilityStaff(permission, body?.facilityId);
    if (!staff) throw new ForbiddenError(permission);

    const order = await prisma.medicationOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Medication order not found.");

    try {
      if (action === "cancel") {
        const reason = body?.reason as string | undefined;
        if (!reason) throw new BadRequestError("reason is required to cancel.");
        return { order: await cancelMedicationOrder(id, reason, staff.id, session.userId) };
      }
      if (action === "discontinue") {
        const reason = body?.reason as string | undefined;
        if (!reason) throw new BadRequestError("reason is required to discontinue.");
        return { order: await discontinueMedicationOrder(id, reason, staff.id, session.userId) };
      }
      if (action === "resubmit") {
        return { order: await resubmitMedicationOrder(id, session.userId, body?.updates) };
      }
      throw new BadRequestError("Unknown action.");
    } catch (err) {
      if (err instanceof InvalidMedicationOrderTransitionError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
