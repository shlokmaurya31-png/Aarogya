import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { createMedicationOrder } from "@/lib/hospital/medicationLifecycle";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const encounterId = searchParams.get("encounterId");
    const status = searchParams.get("status");

    const orders = await prisma.medicationOrder.findMany({
      where: {
        encounter: { facilityId },
        ...(encounterId ? { encounterId } : {}),
        ...(status ? { status: status as never } : {}),
      },
      include: {
        patient: true,
        orderedBy: { include: { user: true } },
        administrations: true,
        safetyWarnings: true,
        verifications: { orderBy: { createdAt: "desc" }, take: 1 },
        dispensingRecords: true,
      },
      orderBy: { orderedAt: "desc" },
      take: 100,
    });
    return { orders };
  });
}

/**
 * CDS runs here, transparently: safety flags are computed and stored on
 * the order (never silently blocking), and a DANGER-severity flag
 * requires the caller to pass overrideReason to proceed at all (brief
 * §20/§101 — "never allow AI alone to determine" applies equally to this
 * deterministic check: it informs, a human still decides). The order is
 * then auto-submitted to pharmacy review — see
 * src/lib/hospital/medicationLifecycle.ts.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("clinical:order:medication", body?.facilityId);
    if (!staff) throw new BadRequestError("Medication orders must be placed by a staff account.");

    const { encounterId, patientId, drugName, genericName, dose, route, frequency, durationDays, overrideReason } = body ?? {};
    if (!encounterId || !patientId || !drugName || !dose || !route || !frequency) {
      throw new BadRequestError("encounterId, patientId, drugName, dose, route and frequency are required.");
    }

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const result = await createMedicationOrder({
      facilityId,
      encounterId,
      patientId,
      orderingStaffId: staff.id,
      drugName,
      genericName,
      dose,
      route,
      frequency,
      durationDays,
      formulation: body?.formulation,
      doseValue: body?.doseValue,
      doseUnit: body?.doseUnit,
      timing: body?.timing,
      prn: body?.prn,
      prnReason: body?.prnReason,
      specialInstructions: body?.specialInstructions,
      indication: body?.indication,
      isControlled: body?.isControlled,
      overrideReason,
      byUserId: session.userId,
    });

    if (result.blocked) return { blocked: true, flags: result.flags };
    return { order: result.order, flags: result.flags };
  });
}
