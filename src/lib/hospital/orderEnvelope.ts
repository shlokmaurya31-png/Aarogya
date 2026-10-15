import type { Prisma, OrderType, OrderStatus, MedicationOrderStatus, LabOrderStatus, ImagingOrderStatus } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * Writes the generalized `Order` envelope row (brief §1 / docs/PHASE_3_ARCHITECTURE.md §1)
 * inside the caller's own transaction — one query per type-specific create,
 * never a separate round trip that could leave the envelope and the real
 * order out of sync. Always called from within the type-specific order's
 * own creation service, never called standalone.
 */
export async function createOrderEnvelope(
  tx: Tx,
  input: {
    facilityId: string;
    encounterId: string;
    patientId: string;
    orderingStaffId: string;
    orderType: OrderType;
    priority?: "ROUTINE" | "URGENT" | "EMERGENCY";
    indication?: string;
    notes?: string;
  }
) {
  // Created ACTIVE (the default); the caller syncs it from the specific order once that exists.
  return tx.order.create({
    data: {
      facilityId: input.facilityId,
      encounterId: input.encounterId,
      patientId: input.patientId,
      orderingStaffId: input.orderingStaffId,
      orderType: input.orderType,
      priority: input.priority,
      indication: input.indication,
      notes: input.notes,
    },
  });
}

/**
 * D9: the specific order's lifecycle is authoritative. `Order.status` is a
 * coarse status derived from it, and syncOrderStatus is the only code that
 * writes it (verify-postgres-order-status checks both). Call it in the same
 * transaction as every change to a specific order's status.
 */
export type SpecificOrderKind = "MEDICATION" | "LAB" | "IMAGING" | "REFERRAL";

const DERIVED: Record<SpecificOrderKind, Record<string, OrderStatus>> = {
  MEDICATION: {
    DRAFT: "DRAFT", ORDERED: "ACTIVE", PHARMACY_REVIEW: "ACTIVE", VERIFIED: "ACTIVE", DISPENSED: "ACTIVE", ACTIVE: "ACTIVE",
    HELD: "ON_HOLD", COMPLETED: "COMPLETED", CANCELLED: "CANCELLED", REJECTED: "CANCELLED", DISCONTINUED: "DISCONTINUED",
  } satisfies Record<MedicationOrderStatus, OrderStatus>,
  LAB: {
    ORDERED: "ACTIVE", COLLECTED: "ACTIVE", IN_PROGRESS: "ACTIVE", RESULTED: "COMPLETED", CANCELLED: "CANCELLED",
  } satisfies Record<LabOrderStatus, OrderStatus>,
  IMAGING: {
    ORDERED: "ACTIVE", SCHEDULED: "ACTIVE", ACQUIRED: "ACTIVE", REPORTED: "COMPLETED", CANCELLED: "CANCELLED",
  } satisfies Record<ImagingOrderStatus, OrderStatus>,
  // Referral.status is a string: DRAFT | PLACED | ACKNOWLEDGED | IN_PROGRESS | COMPLETED | CANCELLED | REJECTED.
  REFERRAL: {
    DRAFT: "DRAFT", PLACED: "ACTIVE", ACKNOWLEDGED: "ACTIVE", IN_PROGRESS: "ACTIVE", COMPLETED: "COMPLETED", CANCELLED: "CANCELLED", REJECTED: "CANCELLED",
  },
};
export const REFERRAL_STATUSES = Object.keys(DERIVED.REFERRAL);

/** The Order.status a specific order's status implies. Throws on a status the mapping doesn't know. */
export function deriveOrderStatus(kind: SpecificOrderKind, specificStatus: string): OrderStatus {
  const derived = DERIVED[kind][specificStatus];
  if (!derived) throw new Error(`No Order status for ${kind} status ${specificStatus}.`);
  return derived;
}

async function readSpecific(tx: Tx, kind: SpecificOrderKind, id: string) {
  const select = { status: true, orderId: true } as const;
  switch (kind) {
    case "MEDICATION": return tx.medicationOrder.findUniqueOrThrow({ where: { id }, select: { ...select, cancelledReason: true } });
    case "LAB": return tx.labOrder.findUniqueOrThrow({ where: { id }, select });
    case "IMAGING": return tx.imagingOrder.findUniqueOrThrow({ where: { id }, select });
    case "REFERRAL": return tx.referral.findUniqueOrThrow({ where: { id }, select });
  }
}

/** Recompute and write Order.status from the specific order `id`. A specific order without an envelope is a no-op. */
export async function syncOrderStatus(tx: Tx, kind: SpecificOrderKind, id: string) {
  const specific = await readSpecific(tx, kind, id);
  if (!specific.orderId) return null;
  const status = deriveOrderStatus(kind, specific.status);
  const order = await tx.order.findUniqueOrThrow({ where: { id: specific.orderId }, select: { status: true } });
  if (order.status === status) return status;
  const reason = "cancelledReason" in specific ? specific.cancelledReason : null;
  await tx.order.update({
    where: { id: specific.orderId },
    data: {
      status,
      ...(status === "CANCELLED" ? { cancelledAt: new Date(), cancelledReason: reason ?? undefined } : {}),
      ...(status === "DISCONTINUED" ? { discontinueAt: new Date() } : {}),
    },
  });
  return status;
}
