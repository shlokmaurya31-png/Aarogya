import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { isLabOrderTransitionAllowed, InvalidLabOrderTransitionError } from "@/lib/hospital/diagnosticsLifecycle";
import { enterResult } from "@/lib/hospital/labResultLifecycle";

const VALID_RESULT_TYPES = ["NUMERIC", "TEXT", "CATEGORICAL", "POSITIVE_NEGATIVE"];
const MAX_TEXT_LENGTH = 10_000;
const MAX_NUMERIC_MAGNITUDE = 1_000_000;

/**
 * Structured result entry (brief §17, extended from the Milestone A single-
 * value flow). Requires the order's specimen to be ACCEPTED — enforced via
 * the LabOrder-level IN_PROGRESS gate, which specimenLifecycle.ts's
 * acceptSpecimen() is the only thing that sets. A critical value still just
 * sets isCritical (brief §20-22) — the existing alert engine
 * (src/lib/hospital/alertEngine.ts) picks it up on the next read, no new
 * alert table. Result release generates the acknowledgement workflow; it
 * does not resolve itself.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("lab:result:enter", body?.facilityId);

    const order = await prisma.labOrder.findUnique({ where: { id }, include: { encounter: true, patient: true } });
    if (!order || order.encounter.facilityId !== facilityId) throw new NotFoundError("Lab order not found.");
    if (!isLabOrderTransitionAllowed(order.status, "RESULTED")) {
      throw new InvalidLabOrderTransitionError(order.status, "RESULTED");
    }

    const { value, unit, referenceRange, isCritical, catalogTestId, resultType, numericValue } = body ?? {};
    if (!value) throw new BadRequestError("value is required.");
    if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) throw new BadRequestError(`value must be a string of at most ${MAX_TEXT_LENGTH} characters.`);
    // Milestone E hardening — Boolean("false") === true in JS, so a
    // string-serialized isCritical:"false" previously persisted as
    // isCritical:true, silently manufacturing a phantom critical alert.
    if (isCritical !== undefined && isCritical !== null && typeof isCritical !== "boolean") {
      throw new BadRequestError("isCritical must be a boolean.");
    }
    if (resultType !== undefined && resultType !== null && !VALID_RESULT_TYPES.includes(resultType)) {
      throw new BadRequestError(`resultType must be one of ${VALID_RESULT_TYPES.join(", ")}.`);
    }
    if (numericValue !== undefined && numericValue !== null) {
      if (typeof numericValue !== "number" || !Number.isFinite(numericValue) || Math.abs(numericValue) > MAX_NUMERIC_MAGNITUDE) {
        throw new BadRequestError(`numericValue must be a finite number with magnitude at most ${MAX_NUMERIC_MAGNITUDE}.`);
      }
    }
    if (catalogTestId) {
      const alreadyResulted = await prisma.labResult.findFirst({ where: { labOrderId: id, catalogTestId, isCurrent: true } });
      if (alreadyResulted) throw new BadRequestError("This panel test already has a current result.");
    }

    const specimen = await prisma.specimen.findFirst({ where: { labOrderId: id, status: "ACCEPTED" }, orderBy: { createdAt: "desc" } });

    const result = await prisma.$transaction((tx) =>
      enterResult(tx, {
        labOrderId: id,
        specimenId: specimen?.id ?? null,
        catalogTestId: catalogTestId ?? null,
        resultType: resultType ?? null,
        value,
        unit,
        numericValue: typeof numericValue === "number" ? numericValue : null,
        referenceRange,
        isCritical: isCritical === true,
        releasedByStaffId: staff?.id,
        patientSex: order.patient.sex,
        patientAgeYears: order.patient.ageYears,
      })
    );

    await recordAuditEvent("hospital.lab.resultEntered", session.userId, { labOrderId: id, resultId: result.id, isCritical: isCritical === true });
    return { result };
  });
}
