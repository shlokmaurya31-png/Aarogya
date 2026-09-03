import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { amendResult } from "@/lib/hospital/labResultLifecycle";

const MAX_TEXT_LENGTH = 10_000;
const MAX_NUMERIC_MAGNITUDE = 1_000_000;

/** Amendment (brief §18) — the previous verified version is preserved unchanged, never overwritten. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; resultId: string }> }) {
  return withApiErrors(async () => {
    const { id, resultId } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("lab:result:amend", body?.facilityId);
    if (!staff) throw new NotFoundError("Staff account required.");

    const result = await prisma.labResult.findUnique({ where: { id: resultId }, include: { labOrder: { include: { encounter: true } } } });
    if (!result || result.labOrderId !== id || result.labOrder.encounter.facilityId !== facilityId) throw new NotFoundError("Lab result not found.");

    const { value, unit, numericValue, isCritical, reason } = body ?? {};
    if (!value) throw new BadRequestError("value is required.");
    if (!reason) throw new BadRequestError("An amendment reason is required.");
    if (typeof value !== "string" || value.length > MAX_TEXT_LENGTH) throw new BadRequestError(`value must be a string of at most ${MAX_TEXT_LENGTH} characters.`);
    if (typeof reason !== "string" || reason.length > MAX_TEXT_LENGTH) throw new BadRequestError(`reason must be a string of at most ${MAX_TEXT_LENGTH} characters.`);
    // Milestone E hardening — unlike result-entry, this route previously
    // passed isCritical straight through with no type check at all; a
    // wrong-typed value hit Prisma's own validation and surfaced as an
    // uncaught 500 instead of a clean 400.
    if (isCritical !== undefined && isCritical !== null && typeof isCritical !== "boolean") {
      throw new BadRequestError("isCritical must be a boolean.");
    }
    if (numericValue !== undefined && numericValue !== null) {
      if (typeof numericValue !== "number" || !Number.isFinite(numericValue) || Math.abs(numericValue) > MAX_NUMERIC_MAGNITUDE) {
        throw new BadRequestError(`numericValue must be a finite number with magnitude at most ${MAX_NUMERIC_MAGNITUDE}.`);
      }
    }

    const { original, amended } = await prisma.$transaction((tx) =>
      amendResult(tx, resultId, { value, unit, numericValue: typeof numericValue === "number" ? numericValue : null, isCritical, reason, amendedByStaffId: staff.id })
    );

    await recordAuditEvent("hospital.lab.resultAmended", session.userId, { labOrderId: id, previousResultId: original.id, amendedResultId: amended.id, reason });
    return { original, amended };
  });
}
