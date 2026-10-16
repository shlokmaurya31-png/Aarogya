import { NextRequest } from "next/server";
import { $Enums } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { parseEnum } from "@/lib/enumValue";
import { priceCharge, waiveCharge } from "@/lib/hospital/billing/chargePricing";

/**
 * POST: resolve a charge posted without a tariff (batch 5, decision 1).
 *   { action: "price", chargeCode } or { action: "price", unitPriceMinor }
 *   { action: "waive", reasonCode }
 * Both change money, so both need billing:adjustment:approve.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ encounterId: string; chargeId: string }> }) {
  return withApiErrors(async () => {
    const { encounterId, chargeId } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:adjustment:approve", body?.facilityId);

    const charge = await prisma.charge.findUnique({ where: { id: chargeId } });
    if (!charge || charge.facilityId !== facilityId || charge.encounterId !== encounterId) throw new NotFoundError("Charge not found.");

    if (body?.action === "price") {
      const updated = await prisma.$transaction((tx) => priceCharge(tx, chargeId, {
        chargeCode: typeof body.chargeCode === "string" ? body.chargeCode : undefined,
        unitPriceMinor: typeof body.unitPriceMinor === "number" ? body.unitPriceMinor : undefined,
        byUserId: session.userId,
      }));
      return { charge: updated };
    }
    if (body?.action === "waive") {
      const reasonCode = parseEnum($Enums.ChargeWaiverReason, body.reasonCode, "reasonCode");
      return { charge: await prisma.$transaction((tx) => waiveCharge(tx, chargeId, { reasonCode, byUserId: session.userId })) };
    }
    throw new BadRequestError('action must be "price" or "waive".');
  });
}
