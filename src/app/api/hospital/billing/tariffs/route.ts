import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { createTariff } from "@/lib/hospital/billing/pricing";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("billing:view", searchParams.get("facilityId") ?? undefined);
    const chargeCode = searchParams.get("chargeCode") ?? undefined;

    const tariffs = await prisma.tariff.findMany({
      where: { facilityId, chargeCode, active: true },
      include: { payer: { select: { name: true, type: true } } },
      orderBy: { effectiveFrom: "desc" },
    });
    return { tariffs };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:tariff:manage", body?.facilityId);

    const { payerId, chargeCode, description, category, unitPriceMinor, currency, effectiveFrom, effectiveTo } = body ?? {};
    if (!payerId) throw new BadRequestError("payerId is required.");
    if (!chargeCode || typeof chargeCode !== "string") throw new BadRequestError("chargeCode is required.");
    if (!description || typeof description !== "string") throw new BadRequestError("description is required.");
    if (!category || typeof category !== "string") throw new BadRequestError("category is required.");
    if (typeof unitPriceMinor !== "number" || unitPriceMinor <= 0) throw new BadRequestError("unitPriceMinor must be a positive number.");
    if (!effectiveFrom) throw new BadRequestError("effectiveFrom is required.");

    const payer = await prisma.payer.findUnique({ where: { id: payerId } });
    if (!payer) throw new NotFoundError("Payer not found.");

    const tariff = await prisma.$transaction((tx) =>
      createTariff(tx, {
        facilityId,
        payerId,
        chargeCode,
        description,
        category,
        unitPriceMinor,
        currency,
        effectiveFrom: new Date(effectiveFrom),
        effectiveTo: effectiveTo ? new Date(effectiveTo) : null,
        createdByUserId: session.userId,
      })
    );

    await recordAuditEvent("hospital.billing.tariffCreated", session.userId, { tariffId: tariff.id, chargeCode, unitPriceMinor }, { facilityId });
    return { tariff };
  });
}
