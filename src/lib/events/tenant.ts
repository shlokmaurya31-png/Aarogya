import { prisma } from "@/lib/db";
import { PermanentEventError } from "./types";

/**
 * Phase D6 — resolve the organization that owns a facility, for FACILITY-scoped
 * clinical events. The tenant scope on an event is ALWAYS server-derived: a
 * clinical service knows the facilityId it is writing in, and the organization is
 * looked up from that facility (never taken from any client input). Pass the same
 * transaction client the mutation uses so the lookup is consistent with the write.
 */
export async function facilityOrganizationId(
  client: Pick<typeof prisma, "facility">,
  facilityId: string,
): Promise<string> {
  const f = await client.facility.findUnique({ where: { id: facilityId }, select: { organizationId: true } });
  if (!f) throw new PermanentEventError(`Facility ${facilityId} not found for event tenant scope.`, "MISSING_FACILITY");
  return f.organizationId;
}
