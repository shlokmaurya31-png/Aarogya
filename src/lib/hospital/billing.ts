import { Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Charge engine (brief §34/§44) — extracted from the manual billing route
 * so the automatic lab-order charge hook (Phase 4 Milestone B) and the
 * existing manual billing UI share one implementation, never two.
 */
export async function createCharge(
  tx: Tx,
  input: {
    encounterId: string;
    patientId: string;
    facilityId: string;
    description: string;
    category: string;
    amount: number;
    sourceType?: string;
    sourceId?: string;
  }
) {
  const charge = await tx.charge.create({
    data: {
      encounterId: input.encounterId,
      patientId: input.patientId,
      facilityId: input.facilityId,
      description: input.description,
      category: input.category,
      amount: input.amount,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    },
  });

  const bill = await tx.bill.upsert({
    where: { encounterId: input.encounterId },
    update: { totalAmount: { increment: input.amount } },
    create: { encounterId: input.encounterId, patientId: input.patientId, facilityId: input.facilityId, totalAmount: input.amount },
  });

  return { charge, bill };
}

/**
 * Idempotent variant for automatic (non-user-initiated) charge triggers —
 * e.g. placing a lab order. Guards against double-charging the same source
 * event (no DB-level unique constraint exists on sourceType+sourceId, so
 * this check is the only protection; the manual billing route deliberately
 * does NOT use this variant, since a human re-entering an identical charge
 * on purpose is a valid, expected action there).
 */
export async function createChargeIfNotExists(
  tx: Tx,
  input: Parameters<typeof createCharge>[1] & { sourceType: string; sourceId: string }
) {
  const existing = await tx.charge.findFirst({ where: { sourceType: input.sourceType, sourceId: input.sourceId } });
  if (existing) return { charge: existing, bill: null, alreadyExisted: true as const };
  const result = await createCharge(tx, input);
  return { ...result, alreadyExisted: false as const };
}
