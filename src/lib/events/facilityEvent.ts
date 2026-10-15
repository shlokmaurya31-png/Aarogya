import type { Prisma } from "@prisma/client";
import { emitDomainEvent } from "./emit";
import { facilityOrganizationId } from "./tenant";

/**
 * Emit a FACILITY-scoped event in the caller's transaction, resolving the
 * organization from the facility (server-side, never from input). Events inside
 * an encounter use the encounter ID as their correlationId (workflow spine
 * §1.0), so one patient journey can be pulled from the outbox.
 */
export async function emitFacilityEvent(
  tx: Prisma.TransactionClient,
  input: {
    type: string;
    aggregateId: string;
    facilityId: string;
    actorUserId?: string | null;
    encounterId?: string | null;
    payload: Record<string, unknown>;
  },
) {
  return emitDomainEvent(tx, {
    type: input.type,
    aggregateId: input.aggregateId,
    organizationId: await facilityOrganizationId(tx, input.facilityId),
    facilityId: input.facilityId,
    actorUserId: input.actorUserId ?? null,
    correlationId: input.encounterId ?? undefined,
    payload: input.payload,
  });
}
