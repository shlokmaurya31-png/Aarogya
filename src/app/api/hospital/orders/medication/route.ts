import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { checkMedicationSafety } from "@/lib/hospital/clinicalSafety";
import { generateAdministrationSchedule } from "@/lib/hospital/medicationSchedule";
import { recordAuditEvent } from "@/lib/auth/audit";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const encounterId = searchParams.get("encounterId");

    const orders = await prisma.medicationOrder.findMany({
      where: {
        encounter: { facilityId },
        ...(encounterId ? { encounterId } : {}),
      },
      include: { patient: true, orderedBy: { include: { user: true } }, administrations: true },
      orderBy: { orderedAt: "desc" },
      take: 100,
    });
    return { orders };
  });
}

/**
 * CDS runs here, transparently: safety flags are computed and stored on the
 * order (never silently blocking), and a DANGER-severity flag requires the
 * caller to pass overrideReason to proceed at all (brief §20/§101 — "never
 * allow AI alone to determine" applies equally to this deterministic
 * check: it informs, a human still decides).
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

    const flags = await checkMedicationSafety(patientId, drugName, genericName);
    const hasDanger = flags.some((f) => f.severity === "danger");
    if (hasDanger && !overrideReason) {
      return { blocked: true, flags };
    }

    const order = await prisma.medicationOrder.create({
      data: {
        encounterId,
        patientId,
        drugName,
        genericName,
        dose,
        route,
        frequency,
        durationDays,
        orderedByStaffId: staff.id,
        safetyFlags: flags.length ? (flags as unknown as object) : undefined,
        overrideReason: hasDanger ? overrideReason : undefined,
      },
    });

    await generateAdministrationSchedule(order.id, frequency);
    await recordAuditEvent("hospital.medication.ordered", session.userId, { orderId: order.id, flags: flags.length, overridden: hasDanger });
    return { order, flags };
  });
}
