import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError, ForbiddenError } from "@/lib/auth/rbac";
import { roleHasPermission } from "@/lib/auth/permissions";
import { recordAuditEvent } from "@/lib/auth/audit";
import { createCharge } from "@/lib/hospital/billing/chargeCapture";
import { computeAccountSummary } from "@/lib/hospital/billing/billingAccount";
import { priceFor } from "@/lib/hospital/billing/pricing";

export async function GET(req: NextRequest, { params }: { params: Promise<{ encounterId: string }> }) {
  return withApiErrors(async () => {
    const { encounterId } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("billing:view", searchParams.get("facilityId") ?? undefined);

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId }, include: { patient: true } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const [charges, invoices, summary] = await Promise.all([
      prisma.charge.findMany({ where: { encounterId }, orderBy: { createdAt: "asc" } }),
      prisma.invoice.findMany({ where: { encounterId }, orderBy: { createdAt: "desc" }, include: { lines: true } }),
      computeAccountSummary(encounterId),
    ]);
    return { encounter, charges, invoices, summary };
  });
}

/**
 * Manual charge entry. Normal path: caller supplies chargeCode, priced
 * server-side via pricing.priceFor — closes the amount-tampering gap the
 * old route had (it trusted a raw client `amount` with only a typeof
 * check). Escalated path: a raw amountMinor override is only accepted when
 * the caller additionally holds billing:adjustment:approve AND supplies a
 * mandatory reason — for genuinely one-off manual pricing a tariff can't
 * cover, never as the default.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ encounterId: string }> }) {
  return withApiErrors(async () => {
    const { encounterId } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("billing:charge:create", body?.facilityId);

    const encounter = await prisma.encounter.findUnique({ where: { id: encounterId } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const { description, category, chargeCode, quantity, amountMinor, reason } = body ?? {};
    if (!description || typeof description !== "string") throw new BadRequestError("description is required.");
    if (!category || typeof category !== "string") throw new BadRequestError("category is required.");

    let charge;
    if (amountMinor !== undefined) {
      if (!roleHasPermission(session.role, "billing:adjustment:approve")) {
        throw new ForbiddenError("billing:adjustment:approve");
      }
      if (typeof amountMinor !== "number" || amountMinor <= 0) throw new BadRequestError("amountMinor must be a positive number.");
      if (!reason || typeof reason !== "string") throw new BadRequestError("A reason is required when overriding the price directly.");

      const result = await prisma.$transaction((tx) =>
        createCharge(tx, {
          encounterId,
          patientId: encounter.patientId,
          facilityId,
          description: `${description} (manual override: ${reason})`,
          category,
          unitPriceMinor: amountMinor,
          postedByUserId: session.userId,
        })
      );
      charge = result.charge;
    } else {
      if (!chargeCode || typeof chargeCode !== "string") throw new BadRequestError("chargeCode is required (or an authorized amountMinor override with a reason).");
      // Priced server-side, same as any automatic charge trigger — a human
      // re-entering an identical charge on purpose is valid here, so this
      // deliberately does NOT go through the idempotent
      // createChargeIfNotExists variant (unlike order-creation hooks).
      const { unitPriceMinor, currency } = await priceFor(facilityId, chargeCode, new Date());

      const result = await prisma.$transaction((tx) =>
        createCharge(tx, {
          encounterId,
          patientId: encounter.patientId,
          facilityId,
          description,
          category,
          chargeCode,
          quantity: typeof quantity === "number" ? quantity : undefined,
          unitPriceMinor,
          currency,
          postedByUserId: session.userId,
        })
      );
      charge = result.charge;
    }

    await recordAuditEvent(
      "hospital.billing.chargeCreated",
      session.userId,
      { chargeId: charge.id, netAmountMinor: charge.netAmountMinor, manual: true },
      { facilityId, patientId: encounter.patientId, encounterId }
    );
    return { charge };
  });
}
