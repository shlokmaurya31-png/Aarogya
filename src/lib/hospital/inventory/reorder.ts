import type { Prisma } from "@prisma/client";
import { clampPageSize } from "./expiry";

type Tx = Prisma.TransactionClient;

export interface ReorderState {
  itemId: string;
  totalOnHand: number;
  reorderPoint: number | null;
  reorderQuantity: number | null;
  belowReorderPoint: boolean;
}

/** Pure computation — no side effects, no automatic purchasing (out of scope this phase). Just surfaces the signal. */
export function computeReorderState(itemId: string, totalOnHand: number, reorderPoint: number | null, reorderQuantity: number | null): ReorderState {
  return { itemId, totalOnHand, reorderPoint, reorderQuantity, belowReorderPoint: reorderPoint != null && totalOnHand <= reorderPoint };
}

/** Server-side paginated low-stock worklist — aggregates StockBalance per item, never loads the whole table into the browser. */
export async function listLowStockItems(tx: Tx, facilityId: string, opts: { cursor?: string; take?: number } = {}) {
  const items = await tx.item.findMany({
    where: { OR: [{ facilityId }, { facilityId: null }], active: true, reorderPoint: { not: null } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    take: clampPageSize(opts.take),
    ...(opts.cursor ? { skip: 1, cursor: { id: opts.cursor } } : {}),
  });

  const results: ReorderState[] = [];
  for (const item of items) {
    const agg = await tx.stockBalance.aggregate({ where: { itemId: item.id, facilityId }, _sum: { onHandQty: true } });
    const state = computeReorderState(item.id, agg._sum.onHandQty ?? 0, item.reorderPoint, item.reorderQuantity);
    if (state.belowReorderPoint) results.push(state);
  }
  return results;
}
