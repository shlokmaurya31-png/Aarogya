import type { Prisma } from "@prisma/client";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

/** SupplyRequestStatusChanged (spine step 9a): one event for department and pharmacy requests, told apart by requestKind. */
export async function emitSupplyRequestStatus(
  tx: Prisma.TransactionClient,
  req: { id: string; facilityId: string; itemId: string; quantity: number; patientId: string | null; encounterId: string | null },
  input: { requestKind: "DEPARTMENT" | "PHARMACY"; from: string; to: string; actorUserId: string },
) {
  await emitFacilityEvent(tx, {
    type: "SupplyRequestStatusChanged", aggregateId: req.id, facilityId: req.facilityId, encounterId: req.encounterId, actorUserId: input.actorUserId,
    payload: {
      requestKind: input.requestKind, requestId: req.id, itemId: req.itemId, quantity: req.quantity, from: input.from, to: input.to,
      ...(req.patientId ? { patientId: req.patientId } : {}), ...(req.encounterId ? { encounterId: req.encounterId } : {}),
    },
  });
}
