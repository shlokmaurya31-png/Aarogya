import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { BadRequestError } from "@/lib/auth/rbac";
import { computeLineNetAmountMinor } from "./money";
import { getOrCreateBillingAccount } from "./billingAccount";
import { priceFor } from "./pricing";
import { createTask } from "@/lib/hospital/task";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

type Tx = Prisma.TransactionClient;

/** Issued (or paid) invoice statuses: a charge posted after one exists is late (batch 5, decision 2). */
/** The charge categories (the billing screen offers exactly these); ChargePosted carries the code. */
export const CHARGE_CATEGORIES = ["CONSULTATION", "BED", "PROCEDURE", "LAB", "IMAGING", "PHARMACY", "NURSING", "PACKAGE", "OTHER"] as const;

function assertChargeCategory(category: string) {
  if (!(CHARGE_CATEGORIES as readonly string[]).includes(category)) throw new BadRequestError(`Unknown charge category: use one of ${CHARGE_CATEGORIES.join(", ")}.`);
}

const ISSUED_INVOICE_STATUSES = ["ISSUED", "PARTIALLY_PAID", "PAID"] as const;

async function encounterIsInvoiced(tx: Tx, encounterId: string): Promise<boolean> {
  return (await tx.invoice.count({ where: { encounterId, documentType: "INVOICE", status: { in: [...ISSUED_INVOICE_STATUSES] } } })) > 0;
}

/**
 * A late charge is recorded like any other (issued invoices are never edited)
 * and raises one billing exception task, so billing collects it on a
 * supplementary invoice or debit note linked to the original.
 */
async function raiseLateChargeTask(tx: Tx, charge: { id: string; facilityId: string; patientId: string; encounterId: string }, actorUserId?: string | null) {
  await createTask(tx, {
    facilityId: charge.facilityId, patientId: charge.patientId, encounterId: charge.encounterId,
    type: "LATE_CHARGE", title: "A charge was posted after the invoice was issued: collect it on a supplementary invoice",
    priority: "URGENT", assignedRole: "BILLING_STAFF", source: "EVENT", idempotencyKey: `LATE_CHARGE:${charge.id}`,
  }, actorUserId);
}

/** ChargePosted (spine §9 step 9), in the charge's own transaction, from every charge path. */
async function emitChargePosted(tx: Tx, charge: {
  id: string; encounterId: string; patientId: string; facilityId: string; category: string; sourceType: string | null; sourceId: string | null;
  netAmountMinor: number; currency: string; pricingStatus: string; isLate: boolean; postedByUserId: string | null;
}) {
  await emitFacilityEvent(tx, {
    type: "ChargePosted", aggregateId: charge.id, facilityId: charge.facilityId, encounterId: charge.encounterId, actorUserId: charge.postedByUserId,
    payload: {
      chargeId: charge.id, encounterId: charge.encounterId, patientId: charge.patientId, category: charge.category,
      ...(charge.sourceType ? { sourceType: charge.sourceType } : {}), ...(charge.sourceId ? { sourceId: charge.sourceId } : {}),
      netAmountMinor: charge.netAmountMinor, currency: charge.currency, pricingStatus: charge.pricingStatus, isLate: charge.isLate,
    },
  });
}

export class ChargeAlreadyInvoicedError extends BadRequestError {
  constructor() {
    super("This charge has already been folded into an invoice — void the invoice line or issue a financial adjustment instead.");
  }
}

interface CreateChargeInput {
  encounterId: string;
  patientId: string;
  facilityId: string;
  description: string;
  category: string; // one of CHARGE_CATEGORIES
  chargeCode?: string | null;
  quantity?: number;
  unitPriceMinor: number;
  discountMinor?: number;
  currency?: string;
  sourceType?: string;
  sourceId?: string;
  postedByUserId?: string | null;
  /** NEEDS_PRICING: posted with no tariff (amount 0); billing prices or waives it before invoicing. */
  pricingStatus?: "PRICED" | "NEEDS_PRICING";
}

/**
 * Charge engine (Layer 1: charge capture). Extracted so the automatic
 * order-creation/dispense/discharge hooks and the manual billing route
 * share one implementation, never two. Every charge derives from clinical
 * activity but never mutates it — provenance travels via sourceType/
 * sourceId only.
 */
export async function createCharge(tx: Tx, input: CreateChargeInput) {
  assertChargeCategory(input.category);
  const quantity = input.quantity ?? 1;
  const discountMinor = input.discountMinor ?? 0;
  const netAmountMinor = computeLineNetAmountMinor(quantity, input.unitPriceMinor, discountMinor);

  await getOrCreateBillingAccount(tx, { encounterId: input.encounterId, patientId: input.patientId, facilityId: input.facilityId });
  const isLate = await encounterIsInvoiced(tx, input.encounterId);

  const charge = await tx.charge.create({
    data: {
      encounterId: input.encounterId,
      patientId: input.patientId,
      facilityId: input.facilityId,
      description: input.description,
      category: input.category,
      chargeCode: input.chargeCode ?? null,
      quantity,
      unitPriceMinor: input.unitPriceMinor,
      discountMinor,
      netAmountMinor,
      currency: input.currency ?? "INR",
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      postedByUserId: input.postedByUserId ?? null,
      isLate,
    },
  });
  await emitChargePosted(tx, charge);
  if (isLate) await raiseLateChargeTask(tx, charge, input.postedByUserId);

  return { charge };
}

/**
 * Idempotent variant for automatic (non-user-initiated) charge triggers —
 * e.g. placing a lab order, dispensing medication, finalizing a discharge's
 * bed charge. Guards against double-charging the same source event via the
 * DB-level `@@unique([sourceType, sourceId])` constraint (proven
 * Postgres-safe since Phase 4) — a genuine race between two concurrent
 * calls for the same sourceId can't both succeed. The manual billing route
 * deliberately does NOT use this variant, since a human re-entering an
 * identical charge on purpose is a valid, expected action there.
 */
export async function createChargeIfNotExists(
  tx: Tx,
  input: CreateChargeInput & { sourceType: string; sourceId: string }
) {
  const existing = await tx.charge.findFirst({ where: { sourceType: input.sourceType, sourceId: input.sourceId } });
  if (existing) return { charge: existing, alreadyExisted: true as const };
  assertChargeCategory(input.category);

  const quantity = input.quantity ?? 1;
  const discountMinor = input.discountMinor ?? 0;
  const netAmountMinor = computeLineNetAmountMinor(quantity, input.unitPriceMinor, discountMinor);
  await getOrCreateBillingAccount(tx, { encounterId: input.encounterId, patientId: input.patientId, facilityId: input.facilityId });
  const isLate = await encounterIsInvoiced(tx, input.encounterId);

  // Raw INSERT ... ON CONFLICT DO NOTHING, not create-then-catch-P2002 and
  // not Prisma's createMany({skipDuplicates}) — the former aborts the
  // whole transaction on Postgres when the INSERT fails (SQLSTATE 25P02),
  // making any further query in that same tx, including a "fetch the
  // winner" fallback, fail too; the latter isn't supported by Prisma's
  // SQLite connector at all (throws "Unknown argument skipDuplicates").
  // ON CONFLICT DO NOTHING is standard SQL supported identically by both
  // SQLite (3.24+) and Postgres, never throws on conflict, and the
  // returned row count tells us who won — verified against both engines
  // under genuine concurrent load (see scripts/verify-postgres-billing-concurrency.ts).
  const rowsInserted = await tx.$executeRaw`
    INSERT INTO "Charge" (id, "encounterId", "patientId", "facilityId", description, category, "chargeCode", quantity, "unitPriceMinor", "discountMinor", "netAmountMinor", currency, "sourceType", "sourceId", "postedByUserId", "pricingStatus", "isLate")
    VALUES (${randomUUID()}, ${input.encounterId}, ${input.patientId}, ${input.facilityId}, ${input.description}, ${input.category}, ${input.chargeCode ?? null}, ${quantity}, ${input.unitPriceMinor}, ${discountMinor}, ${netAmountMinor}, ${input.currency ?? "INR"}, ${input.sourceType}, ${input.sourceId}, ${input.postedByUserId ?? null}, ${input.pricingStatus ?? "PRICED"}::"ChargePricingStatus", ${isLate})
    ON CONFLICT ("sourceType", "sourceId") DO NOTHING
  `;
  const charge = await tx.charge.findFirstOrThrow({ where: { sourceType: input.sourceType, sourceId: input.sourceId } });
  if (rowsInserted > 0) {
    await emitChargePosted(tx, charge);
    if (charge.isLate) await raiseLateChargeTask(tx, charge, input.postedByUserId);
  }

  return { charge, alreadyExisted: rowsInserted === 0 };
}

/**
 * Convenience wrapper for the common case: caller supplies a chargeCode
 * instead of a raw amount, this looks up the server-side price via
 * pricing.priceFor and delegates to createChargeIfNotExists — this is the
 * mechanism that closes the amount-tampering gap consistently across
 * every automatic charge trigger (lab, imaging, pharmacy, bed).
 */
export async function createPricedChargeIfNotExists(
  tx: Tx,
  input: Omit<CreateChargeInput, "unitPriceMinor" | "currency"> & {
    chargeCode: string;
    sourceType: string;
    sourceId: string;
    payerId?: string;
    atDate?: Date;
  }
) {
  const { unitPriceMinor, currency } = await priceFor(input.facilityId, input.chargeCode, input.atDate ?? new Date(), input.payerId);
  return createChargeIfNotExists(tx, { ...input, unitPriceMinor, currency });
}

/** POSTED -> VOIDED only, and only while not yet folded into an issued InvoiceLine (see Charge's doc comment). Guarded — a losing concurrent void gets a clean rejection, never a corrupted write. */
export async function voidCharge(tx: Tx, chargeId: string, input: { reason: string; byUserId: string }) {
  const charge = await tx.charge.findUniqueOrThrow({ where: { id: chargeId }, include: { invoiceLine: true } });
  if (charge.invoiceLine) throw new ChargeAlreadyInvoicedError();

  const result = await tx.charge.updateMany({
    where: { id: chargeId, status: "POSTED" },
    data: { status: "VOIDED", voidedAt: new Date(), voidedByUserId: input.byUserId, voidReason: input.reason },
  });
  if (result.count !== 1) throw new BadRequestError("Charge was already voided or is no longer in the expected state.");
  await emitFacilityEvent(tx, {
    type: "ChargeVoided", aggregateId: charge.id, facilityId: charge.facilityId, encounterId: charge.encounterId, actorUserId: input.byUserId,
    payload: { chargeId: charge.id, encounterId: charge.encounterId, patientId: charge.patientId, netAmountMinor: charge.netAmountMinor, currency: charge.currency },
  });
  return tx.charge.findUniqueOrThrow({ where: { id: chargeId } });
}
