import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { assertOrganizationAccess, type ActorMemberships } from "@/lib/auth/tenantContext";
import { requirePlatform } from "@/lib/billing/authz";

/**
 * Phase D5 — reconciliation & leakage operational intelligence.
 *
 * Read dashboards over BillingReconciliationException (both provider
 * RECONCILIATION exceptions and D5 LEAKAGE findings), plus authorized, race-safe
 * triage (assign / acknowledge / resolve / dismiss). A resolution records WHAT
 * happened; it NEVER silently alters canonical money state.
 */

const STATUS_TRANSITIONS: Record<string, string[]> = {
  OPEN: ["ACKNOWLEDGED", "RESOLVED", "DISMISSED"],
  ACKNOWLEDGED: ["RESOLVED", "DISMISSED"],
  RESOLVED: [],
  DISMISSED: [],
};

export async function getReconciliationDashboard(m: ActorMemberships, opts?: { now?: Date }) {
  requirePlatform(m);
  const now = opts?.now ?? new Date();
  const open = await prisma.billingReconciliationException.findMany({
    where: { resolved: false },
    select: { id: true, kind: true, severity: true, providerKind: true, source: true, createdAt: true },
  });
  const byType: Record<string, number> = {}; const byProvider: Record<string, number> = {}; const bySeverity: Record<string, number> = {};
  const age = { "0-1d": 0, "1-7d": 0, "7-30d": 0, "30d+": 0 };
  for (const e of open) {
    byType[e.kind] = (byType[e.kind] ?? 0) + 1;
    byProvider[e.providerKind] = (byProvider[e.providerKind] ?? 0) + 1;
    bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
    const d = (now.getTime() - e.createdAt.getTime()) / 86_400_000;
    if (d <= 1) age["0-1d"]++; else if (d <= 7) age["1-7d"]++; else if (d <= 30) age["7-30d"]++; else age["30d+"]++;
  }
  const recentlyResolved = await prisma.billingReconciliationException.findMany({
    where: { resolved: true }, orderBy: { resolvedAt: "desc" }, take: 10,
    select: { id: true, kind: true, severity: true, status: true, resolvedAt: true, resolvedByUserId: true },
  });
  return {
    openCount: open.length,
    criticalCount: open.filter((e) => e.severity === "CRITICAL").length,
    byType, byProvider, bySeverity, byAge: age,
    recentlyResolved,
  };
}

/** Platform-only list with filters. */
export async function listExceptions(m: ActorMemberships, opts?: { status?: string; source?: string; resolved?: boolean; limit?: number }) {
  requirePlatform(m);
  return prisma.billingReconciliationException.findMany({
    where: {
      ...(opts?.status ? { status: opts.status } : {}),
      ...(opts?.source ? { source: opts.source } : {}),
      ...(opts?.resolved !== undefined ? { resolved: opts.resolved } : {}),
    },
    orderBy: [{ resolved: "asc" }, { createdAt: "desc" }],
    take: Math.min(opts?.limit ?? 100, 500),
  });
}

/** Tenant-scoped: an organization's own exceptions/findings (for the org profile). */
export async function listOrganizationExceptions(m: ActorMemberships, organizationId: string) {
  assertOrganizationAccess(m, organizationId);
  return prisma.billingReconciliationException.findMany({
    where: { organizationId }, orderBy: [{ resolved: "asc" }, { createdAt: "desc" }], take: 100,
    select: { id: true, kind: true, severity: true, status: true, source: true, description: true, createdAt: true, resolvedAt: true },
  });
}

export async function assignException(m: ActorMemberships, id: string, assignedToUserId: string) {
  requirePlatform(m);
  const ex = await prisma.billingReconciliationException.findUnique({ where: { id }, select: { organizationId: true, resolved: true } });
  if (!ex) throw new NotFoundError();
  if (ex.resolved) throw new BadRequestError("Cannot assign a resolved exception.");
  const res = await prisma.billingReconciliationException.updateMany({ where: { id, resolved: false }, data: { assignedToUserId } });
  if (res.count !== 1) throw new ConflictError("Exception changed concurrently.");
  await recordAuditEvent("commercial.reconciliation.assigned", m.userId, { id, assignedToUserId }, { organizationId: ex.organizationId ?? undefined });
  return prisma.billingReconciliationException.findUniqueOrThrow({ where: { id } });
}

/**
 * Race-safe status transition. The guarded updateMany matches the current status,
 * so two concurrent transitions cannot both win. RESOLVED/DISMISSED set the fast
 * `resolved` boolean + resolver attribution. Money is never touched here.
 */
export async function transitionException(m: ActorMemberships, id: string, to: "ACKNOWLEDGED" | "RESOLVED" | "DISMISSED", resolution?: string) {
  requirePlatform(m);
  const ex = await prisma.billingReconciliationException.findUnique({ where: { id }, select: { status: true, organizationId: true } });
  if (!ex) throw new NotFoundError();
  if (!STATUS_TRANSITIONS[ex.status]?.includes(to)) throw new BadRequestError(`Cannot move exception from ${ex.status} to ${to}.`);
  const terminal = to === "RESOLVED" || to === "DISMISSED";
  if (terminal && !resolution?.trim()) throw new BadRequestError("A resolution note is required to resolve or dismiss.");
  // The guarded updateMany (matches current status) plus the emitted domain event
  // run in one transaction so ReconciliationExceptionResolved is durable iff the
  // transition committed. The status guard still makes concurrent transitions
  // race-safe: only one caller's updateMany matches, the other gets count 0.
  await prisma.$transaction(async (tx) => {
    const res = await tx.billingReconciliationException.updateMany({
      where: { id, status: ex.status },
      // Clearing findingKey on a terminal state frees the leakage dedupe slot so the
      // same condition, if it persists, can be re-detected as a fresh finding.
      data: { status: to, resolution: resolution ?? undefined, resolved: terminal, resolvedByUserId: terminal ? m.userId : undefined, resolvedAt: terminal ? new Date() : undefined, findingKey: terminal ? null : undefined },
    });
    if (res.count !== 1) throw new ConflictError("Exception changed concurrently.");
    if (terminal && ex.organizationId) {
      await emitDomainEvent(tx, {
        type: "ReconciliationExceptionResolved",
        aggregateId: id,
        organizationId: ex.organizationId,
        actorUserId: m.userId,
        payload: { exceptionId: id, status: to },
      });
    }
    const evt = to === "ACKNOWLEDGED" ? "commercial.reconciliation.acknowledged" : to === "DISMISSED" ? "commercial.reconciliation.dismissed" : "commercial.leakage.findingUpdated";
    await recordAuditEvent(evt, m.userId, { id, to }, { organizationId: ex.organizationId ?? undefined }, tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
  return prisma.billingReconciliationException.findUniqueOrThrow({ where: { id } });
}
