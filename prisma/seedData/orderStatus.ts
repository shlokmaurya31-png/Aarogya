import type { PrismaClient } from "@prisma/client";
import { syncOrderStatus, type SpecificOrderKind } from "../../src/lib/hospital/orderEnvelope";

/**
 * D9: the seed writes specific orders' statuses directly to build its
 * scenarios, so finish by deriving every envelope's Order.status through the
 * one writer.
 */
export async function syncSeededOrderStatuses(db: PrismaClient) {
  const withEnvelope = { orderId: { not: null } };
  const rows: [SpecificOrderKind, { id: string }[]][] = [
    ["MEDICATION", await db.medicationOrder.findMany({ where: withEnvelope, select: { id: true } })],
    ["LAB", await db.labOrder.findMany({ where: withEnvelope, select: { id: true } })],
    ["IMAGING", await db.imagingOrder.findMany({ where: withEnvelope, select: { id: true } })],
    ["REFERRAL", await db.referral.findMany({ where: withEnvelope, select: { id: true } })],
  ];
  let n = 0;
  for (const [kind, list] of rows) {
    for (const { id } of list) {
      await db.$transaction((tx) => syncOrderStatus(tx, kind, id));
      n++;
    }
  }
  return n;
}
