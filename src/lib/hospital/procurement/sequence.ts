import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { BadRequestError } from "@/lib/auth/rbac";
export { formatSequenceNumber } from "@/lib/hospital/billing/sequence";

type Tx = Prisma.TransactionClient;

export class SequenceContentionError extends BadRequestError {
  constructor() {
    super("Could not allocate a sequence number — too much concurrent contention. Please retry.");
  }
}

/**
 * Each function below copies billing/sequence.ts#nextSequence's exact
 * idiom against its own dedicated table — the established convention in
 * this codebase (see that file's own doc comment) is to duplicate this
 * small idiom per numbered-document type rather than generalize the
 * shared InvoiceSequence table/key shape. Kept as three explicit,
 * near-identical functions (not one generic table-name-parameterized
 * helper) because a portable tagged-template $executeRaw can't take a
 * table name as a bind parameter — only $executeRawUnsafe can, and that
 * uses engine-specific positional placeholder syntax (`?` for SQLite,
 * `$1` for Postgres), which would silently break one engine.
 */

export async function nextPurchaseRequisitionSequence(tx: Tx, key: { facilityId: string; fiscalYear: number }): Promise<number> {
  await tx.$executeRaw`
    INSERT INTO "PurchaseRequisitionSequence" (id, "facilityId", "fiscalYear", "nextValue")
    VALUES (${randomUUID()}, ${key.facilityId}, ${key.fiscalYear}, 1)
    ON CONFLICT ("facilityId", "fiscalYear") DO NOTHING
  `;
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await tx.purchaseRequisitionSequence.findUniqueOrThrow({ where: { facilityId_fiscalYear: key } });
    const result = await tx.purchaseRequisitionSequence.updateMany({
      where: { facilityId: key.facilityId, fiscalYear: key.fiscalYear, nextValue: current.nextValue },
      data: { nextValue: current.nextValue + 1 },
    });
    if (result.count === 1) return current.nextValue;
  }
  throw new SequenceContentionError();
}

export async function nextPurchaseOrderSequence(tx: Tx, key: { facilityId: string; fiscalYear: number }): Promise<number> {
  await tx.$executeRaw`
    INSERT INTO "PurchaseOrderSequence" (id, "facilityId", "fiscalYear", "nextValue")
    VALUES (${randomUUID()}, ${key.facilityId}, ${key.fiscalYear}, 1)
    ON CONFLICT ("facilityId", "fiscalYear") DO NOTHING
  `;
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await tx.purchaseOrderSequence.findUniqueOrThrow({ where: { facilityId_fiscalYear: key } });
    const result = await tx.purchaseOrderSequence.updateMany({
      where: { facilityId: key.facilityId, fiscalYear: key.fiscalYear, nextValue: current.nextValue },
      data: { nextValue: current.nextValue + 1 },
    });
    if (result.count === 1) return current.nextValue;
  }
  throw new SequenceContentionError();
}

export async function nextGoodsReceiptSequence(tx: Tx, key: { facilityId: string; fiscalYear: number }): Promise<number> {
  await tx.$executeRaw`
    INSERT INTO "GoodsReceiptSequence" (id, "facilityId", "fiscalYear", "nextValue")
    VALUES (${randomUUID()}, ${key.facilityId}, ${key.fiscalYear}, 1)
    ON CONFLICT ("facilityId", "fiscalYear") DO NOTHING
  `;
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await tx.goodsReceiptSequence.findUniqueOrThrow({ where: { facilityId_fiscalYear: key } });
    const result = await tx.goodsReceiptSequence.updateMany({
      where: { facilityId: key.facilityId, fiscalYear: key.fiscalYear, nextValue: current.nextValue },
      data: { nextValue: current.nextValue + 1 },
    });
    if (result.count === 1) return current.nextValue;
  }
  throw new SequenceContentionError();
}
