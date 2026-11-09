import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError, ConflictError } from "@/lib/auth/rbac";
import { BadPrnOrderError, givePrnDose, MedicationOrderNotActiveError, PrnLimitError } from "@/lib/hospital/medicationLifecycle";

/**
 * POST { witnessStaffId?, notes? }: one as-needed (PRN) dose given now
 * (Flagship 4a). Refused (409) when it would breach the order's minimum
 * interval or its maximum doses in 24 hours.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("medication:administer", body?.facilityId);
    if (!staff) throw new BadRequestError("Recording a dose needs a staff account.");
    const order = await prisma.medicationOrder.findUnique({ where: { id }, select: { encounter: { select: { facilityId: true } } } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Medication order not found.");
    try {
      const administration = await givePrnDose({ orderId: id, facilityId, administeredByStaffId: staff.id, byUserId: session.userId, witnessStaffId: typeof body?.witnessStaffId === "string" ? body.witnessStaffId : undefined, notes: typeof body?.notes === "string" ? body.notes.slice(0, 500) : undefined });
      return { administration };
    } catch (err) {
      if (err instanceof PrnLimitError) throw new ConflictError(err.message);
      if (err instanceof BadPrnOrderError || err instanceof MedicationOrderNotActiveError) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
