import type { Prisma } from "@prisma/client";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

/**
 * StockDocumentStatusChanged (spine step 9a; triage approved change 2): one
 * decision event for the approval-gated inventory documents, told apart by the
 * closed documentType. Emitted in the decision's transaction.
 */
export async function emitStockDocumentStatus(
  tx: Prisma.TransactionClient,
  input: {
    documentType: "ADJUSTMENT" | "WASTE" | "GOODS_RECEIPT" | "STOCK_TAKE"; documentId: string; facilityId: string;
    from: string; to: string; itemId?: string | null; locationId?: string | null; varianceLineCount?: number; actorUserId?: string | null;
  },
) {
  await emitFacilityEvent(tx, {
    type: "StockDocumentStatusChanged", aggregateId: input.documentId, facilityId: input.facilityId, actorUserId: input.actorUserId ?? null,
    payload: {
      documentType: input.documentType, documentId: input.documentId, from: input.from, to: input.to,
      ...(input.itemId ? { itemId: input.itemId } : {}), ...(input.locationId ? { locationId: input.locationId } : {}),
      ...(input.varianceLineCount !== undefined ? { varianceLineCount: input.varianceLineCount } : {}),
    },
  });
}
