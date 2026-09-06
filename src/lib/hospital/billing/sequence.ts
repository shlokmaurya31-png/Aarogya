import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { BadRequestError } from "@/lib/auth/rbac";

type Tx = Prisma.TransactionClient;

export class SequenceContentionError extends BadRequestError {
  constructor() {
    super("Could not allocate a sequence number — too much concurrent contention. Please retry.");
  }
}

/**
 * Per-(facilityId, fiscalYear) atomic counter, reused for both Invoice and
 * Claim numbering. CAS-based (guarded updateMany + bounded retry), the same
 * idiom every other stateful entity in this codebase uses for concurrency
 * safety — deliberately NOT a Postgres-only SERIAL/advisory lock, so the
 * exact same code path is safe on SQLite and Postgres. Must be called
 * inside the caller's own transaction so the sequence bump and the row
 * that consumes it (Invoice/Claim) commit or roll back together.
 */
export async function nextSequence(tx: Tx, key: { facilityId: string; fiscalYear: number }): Promise<number> {
  // Raw INSERT ... ON CONFLICT DO NOTHING — see chargeCapture.ts's
  // createChargeIfNotExists for the full explanation.
  await tx.$executeRaw`
    INSERT INTO "InvoiceSequence" (id, "facilityId", "fiscalYear", "nextValue")
    VALUES (${randomUUID()}, ${key.facilityId}, ${key.fiscalYear}, 1)
    ON CONFLICT ("facilityId", "fiscalYear") DO NOTHING
  `;

  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await tx.invoiceSequence.findUniqueOrThrow({ where: { facilityId_fiscalYear: key } });
    const result = await tx.invoiceSequence.updateMany({
      where: { facilityId: key.facilityId, fiscalYear: key.fiscalYear, nextValue: current.nextValue },
      data: { nextValue: current.nextValue + 1 },
    });
    if (result.count === 1) return current.nextValue;
  }
  throw new SequenceContentionError();
}

/** "INV-2027-000042" style — facility-aware (via the caller passing a facility-scoped sequence value), zero-padded, audit-legible. */
export function formatSequenceNumber(prefix: string, fiscalYear: number, value: number): string {
  return `${prefix}-${fiscalYear}-${String(value).padStart(6, "0")}`;
}
