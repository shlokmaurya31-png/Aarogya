import { prisma } from "@/lib/db";
import { emitFamilyAccessRevoked } from "./family";

/**
 * Workflow spine §3.4: delegations past their `expiresAt` become EXPIRED, each
 * in its own transaction with a guarded update. An ACTIVE one ended access, so
 * it emits FamilyAccessRevoked (reason EXPIRED); an invitation that lapses
 * gave no access and emits nothing (triage: inviteDelegate is a process step).
 */
export async function sweepDelegationExpiry(opts: { now?: Date; batchSize?: number } = {}): Promise<{ expired: number }> {
  const now = opts.now ?? new Date();
  const due = await prisma.patientDelegation.findMany({
    where: { status: { in: ["INVITED", "ACTIVE"] }, expiresAt: { not: null, lte: now } },
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: opts.batchSize ?? 200,
    select: { id: true, status: true, version: true, patientId: true, delegateUserId: true },
  });
  let expired = 0;
  for (const d of due) {
    const done = await prisma.$transaction(async (tx) => {
      const r = await tx.patientDelegation.updateMany({ where: { id: d.id, status: d.status, version: d.version }, data: { status: "EXPIRED", version: { increment: 1 } } });
      if (r.count !== 1) return false;
      if (d.status === "ACTIVE" && d.delegateUserId) await emitFamilyAccessRevoked(tx, { id: d.id, patientId: d.patientId, delegateUserId: d.delegateUserId }, "EXPIRED");
      return true;
    });
    if (done) expired++;
  }
  return { expired };
}
