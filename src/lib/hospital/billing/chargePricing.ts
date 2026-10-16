import type { ChargeWaiverReason, Prisma } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { computeLineNetAmountMinor } from "./money";
import { priceFor } from "./pricing";
import { syncDraftLineForCharge } from "./invoices";

type Tx = Prisma.TransactionClient;

export class ChargeNotAwaitingPriceError extends BadRequestError {
  constructor(status: string) {
    super(`This charge is ${status.toLowerCase().replace("_", " ")}, not awaiting a price.`);
  }
}

const NEEDS_PRICING_SUFFIX = " (needs pricing)";

/**
 * Price a charge posted without a tariff (batch 5, decision 1): from a tariff
 * code (server-side price) or an explicit amount, guarded on the charge still
 * being NEEDS_PRICING and POSTED. A DRAFT invoice line follows; an issued one
 * can't exist (issueInvoice refuses unpriced lines). Emits ChargeRepriced.
 */
export async function priceCharge(tx: Tx, chargeId: string, input: { chargeCode?: string; unitPriceMinor?: number; byUserId: string }) {
  const charge = await tx.charge.findUniqueOrThrow({ where: { id: chargeId } });
  if (charge.pricingStatus !== "NEEDS_PRICING" || charge.status !== "POSTED") throw new ChargeNotAwaitingPriceError(charge.status === "POSTED" ? charge.pricingStatus : charge.status);
  let unitPriceMinor: number;
  let chargeCode = charge.chargeCode;
  if (input.chargeCode) {
    unitPriceMinor = (await priceFor(charge.facilityId, input.chargeCode, new Date())).unitPriceMinor;
    chargeCode = input.chargeCode;
  } else if (Number.isInteger(input.unitPriceMinor) && input.unitPriceMinor! >= 0) {
    unitPriceMinor = input.unitPriceMinor!;
  } else {
    throw new BadRequestError("A tariff chargeCode or a non-negative integer unitPriceMinor is required.");
  }
  const netAmountMinor = computeLineNetAmountMinor(charge.quantity, unitPriceMinor, charge.discountMinor);
  const r = await tx.charge.updateMany({
    where: { id: chargeId, pricingStatus: "NEEDS_PRICING", status: "POSTED" },
    data: {
      pricingStatus: "PRICED", unitPriceMinor, netAmountMinor, chargeCode, pricedAt: new Date(), pricedByUserId: input.byUserId,
      description: charge.description.endsWith(NEEDS_PRICING_SUFFIX) ? charge.description.slice(0, -NEEDS_PRICING_SUFFIX.length) : charge.description,
    },
  });
  if (r.count !== 1) throw new ChargeNotAwaitingPriceError(charge.pricingStatus);
  await syncDraftLineForCharge(tx, chargeId);
  await tx.auditEvent.create({ data: { type: "hospital.billing.chargePriced", userId: input.byUserId, detail: { chargeId, chargeCode, unitPriceMinor }, facilityId: charge.facilityId, patientId: charge.patientId, encounterId: charge.encounterId } });
  await emitFacilityEvent(tx, {
    type: "ChargeRepriced", aggregateId: chargeId, facilityId: charge.facilityId, actorUserId: input.byUserId, encounterId: charge.encounterId,
    payload: { chargeId, encounterId: charge.encounterId, patientId: charge.patientId, unitPriceMinor, netAmountMinor, currency: charge.currency, fromTariff: Boolean(input.chargeCode) },
  });
  return tx.charge.findUniqueOrThrow({ where: { id: chargeId } });
}

/** Waive a charge awaiting a price, with a reason code (audited; ChargeWaived). It stays at 0 and can be invoiced. */
export async function waiveCharge(tx: Tx, chargeId: string, input: { reasonCode: ChargeWaiverReason; byUserId: string }) {
  const charge = await tx.charge.findUniqueOrThrow({ where: { id: chargeId } });
  if (charge.pricingStatus !== "NEEDS_PRICING" || charge.status !== "POSTED") throw new ChargeNotAwaitingPriceError(charge.status === "POSTED" ? charge.pricingStatus : charge.status);
  const r = await tx.charge.updateMany({
    where: { id: chargeId, pricingStatus: "NEEDS_PRICING", status: "POSTED" },
    data: { pricingStatus: "WAIVED", waiverReason: input.reasonCode, waivedAt: new Date(), waivedByUserId: input.byUserId },
  });
  if (r.count !== 1) throw new ChargeNotAwaitingPriceError(charge.pricingStatus);
  await syncDraftLineForCharge(tx, chargeId);
  await tx.auditEvent.create({ data: { type: "hospital.billing.chargeWaived", userId: input.byUserId, detail: { chargeId, reasonCode: input.reasonCode }, facilityId: charge.facilityId, patientId: charge.patientId, encounterId: charge.encounterId } });
  await emitFacilityEvent(tx, {
    type: "ChargeWaived", aggregateId: chargeId, facilityId: charge.facilityId, actorUserId: input.byUserId, encounterId: charge.encounterId,
    payload: { chargeId, encounterId: charge.encounterId, patientId: charge.patientId, reasonCode: input.reasonCode },
  });
  return tx.charge.findUniqueOrThrow({ where: { id: chargeId } });
}
