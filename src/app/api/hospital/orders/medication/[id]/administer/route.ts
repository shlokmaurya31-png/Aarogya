import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { administerMedication, AdministrationNotDueError, MedicationOrderNotActiveError } from "@/lib/hospital/medicationLifecycle";

const VALID_STATUSES = ["GIVEN", "HELD", "REFUSED", "MISSED", "CANCELLED"];

/**
 * MAR entry (brief §20-21) — nurse records GIVEN/HELD/REFUSED/MISSED/CANCELLED.
 * Transactional and concurrency-safe: administerMedication() re-checks the
 * administration row's own status inside its transaction, so a double
 * click cannot record the same dose twice (brief §36).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("medication:administer", body?.facilityId);

    const order = await prisma.medicationOrder.findUnique({ where: { id }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Medication order not found.");

    const status = VALID_STATUSES.includes(body?.status) ? body.status : "GIVEN";
    const administrationId = body?.administrationId as string | undefined;
    if (!administrationId) throw new BadRequestError("administrationId is required.");
    if ((status === "HELD" || status === "REFUSED" || status === "MISSED") && !body?.reasonCode) {
      throw new BadRequestError("reasonCode is required when not administering as scheduled.");
    }

    try {
      const administration = await administerMedication({
        administrationId,
        status,
        administeredByStaffId: staff?.id,
        witnessStaffId: body?.witnessStaffId,
        safetyChecksConfirmed: Boolean(body?.safetyChecksConfirmed),
        reasonCode: body?.reasonCode,
        notes: body?.notes,
        byUserId: session.userId,
      });
      return { administration };
    } catch (err) {
      if (err instanceof AdministrationNotDueError || err instanceof MedicationOrderNotActiveError) throw new BadRequestError(err.message);
      if (err instanceof Error && err.message.includes("witness")) throw new BadRequestError(err.message);
      throw err;
    }
  });
}
