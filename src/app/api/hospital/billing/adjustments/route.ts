import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { createAdjustment } from "@/lib/hospital/billing/adjustments";
import { AdjustmentType } from "@prisma/client";

const VALID_TYPES: string[] = Object.values(AdjustmentType);

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:adjustment:create", body?.facilityId);

    const { invoiceId, type, amountMinor, reason } = body ?? {};
    if (!invoiceId) throw new BadRequestError("invoiceId is required.");
    if (!type || !VALID_TYPES.includes(type)) throw new BadRequestError(`type must be one of ${VALID_TYPES.join(", ")}.`);
    if (typeof amountMinor !== "number" || amountMinor <= 0) throw new BadRequestError("amountMinor must be a positive number.");
    if (!reason || typeof reason !== "string") throw new BadRequestError("A reason is required.");

    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice || invoice.facilityId !== facilityId) throw new NotFoundError("Invoice not found.");

    const adjustment = await prisma.$transaction((tx) =>
      createAdjustment(tx, { invoiceId, type, amountMinor, reason, requestedByUserId: session.userId })
    );

    await recordAuditEvent(
      "hospital.adjustment.created",
      session.userId,
      { adjustmentId: adjustment.id, invoiceId, type, amountMinor, reason },
      { facilityId, patientId: invoice.patientId, encounterId: invoice.encounterId }
    );
    return { adjustment };
  });
}
