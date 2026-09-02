import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { dispenseMedication, InvalidMedicationOrderTransitionError } from "@/lib/hospital/medicationLifecycle";

/** Dispensing (brief §23-25) — full/partial/substituted, with an optional witness co-sign for controlled medications (never a silent substitution). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("medication:dispense", body?.facilityId);
    if (!staff) throw new BadRequestError("Dispensing must be performed by a staff account.");

    const order = await prisma.medicationOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Medication order not found.");

    const { quantity, quantityUnit } = body ?? {};
    if (!quantity || !quantityUnit) throw new BadRequestError("quantity and quantityUnit are required.");
    if (body?.status === "SUBSTITUTED" && !body?.substitutedDrugName) throw new BadRequestError("substitutedDrugName is required for a substitution.");

    try {
      const result = await dispenseMedication({
        medicationOrderId: id,
        pharmacistStaffId: staff.id,
        status: body?.status,
        quantity,
        quantityUnit,
        batchNumber: body?.batchNumber,
        expiryDate: body?.expiryDate ? new Date(body.expiryDate) : undefined,
        substitutedDrugName: body?.substitutedDrugName,
        destination: body?.destination,
        witnessStaffId: body?.witnessStaffId,
        notes: body?.notes,
        byUserId: session.userId,
      });
      return result;
    } catch (err) {
      if (err instanceof InvalidMedicationOrderTransitionError) throw new BadRequestError(err.message);
      if (err instanceof Error) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
