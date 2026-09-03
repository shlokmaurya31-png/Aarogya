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
 * event; the findFirst below is a fast-path clean rejection, now backed by
 * a real DB-level `@@unique([sourceType, sourceId])` constraint (Milestone
 * E hardening, see prisma/migrations) so a genuine race between two
 * concurrent calls for the same sourceId can't both succeed even on
 * Postgres's default isolation level. The manual billing route deliberately
 * does NOT use this variant, since a human re-entering an identical charge
 * on purpose is a valid, expected action there.
 */
export async function createChargeIfNotExists(
  tx: Tx,
  input: Parameters<typeof createCharge>[1] & { sourceType: string; sourceId: string }
) {
  const existing = await tx.charge.findFirst({ where: { sourceType: input.sourceType, sourceId: input.sourceId } });
  if (existing) return { charge: existing, bill: null, alreadyExisted: true as const };
  try {
    const result = await createCharge(tx, input);
    return { ...result, alreadyExisted: false as const };
  } catch (err) {
    // A genuine race lost to the DB-level unique constraint (see the doc
    // comment above) — fall back to the row the winner just created rather
    // than surfacing a raw 500 for what is, from the caller's perspective,
    // a successful idempotent charge.
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002") {
      const winner = await tx.charge.findFirstOrThrow({ where: { sourceType: input.sourceType, sourceId: input.sourceId } });
      return { charge: winner, bill: null, alreadyExisted: true as const };
    }
    throw err;
  }
}
