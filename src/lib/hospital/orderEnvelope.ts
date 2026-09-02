import { Prisma, OrderType, OrderStatus } from "@prisma/client";

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

/** Closes an Order envelope's coarse status alongside its type-specific detail row's own status change — keeps the two in sync without making Order the source of truth for type-specific workflow. */
export async function closeOrderEnvelope(
  tx: Tx,
  orderId: string | null | undefined,
  status: Extract<OrderStatus, "COMPLETED" | "CANCELLED" | "DISCONTINUED" | "ON_HOLD">,
  opts: { reason?: string } = {}
) {
  if (!orderId) return;
  await tx.order.update({
    where: { id: orderId },
    data: {
      status,
      ...(status === "CANCELLED" ? { cancelledAt: new Date(), cancelledReason: opts.reason } : {}),
      ...(status === "DISCONTINUED" ? { discontinueAt: new Date() } : {}),
    },
  });
}
