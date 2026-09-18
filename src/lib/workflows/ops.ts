import { prisma } from "@/lib/db";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { requireWorkflowPlatform } from "./authz";

/**
 * Phase D7 — workflow-engine operational metrics (§34). These are ENGINE metrics
 * (execution/queue health), never business KPIs — D6 events remain the analytics
 * boundary. Platform-only.
 */
export async function getWorkflowMetrics(m: ActorMemberships, opts?: { now?: Date }) {
  requireWorkflowPlatform(m);
  const now = opts?.now ?? new Date();

  const [instByStatus, taskByStatus, timerByStatus, activeDefs, overdueTasks, dueTimers, latencySample] = await Promise.all([
    prisma.workflowInstance.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.workflowTask.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.workflowTimer.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.workflowDefinition.count({ where: { status: "ACTIVE" } }),
    prisma.workflowTask.count({ where: { status: { in: ["OPEN", "IN_PROGRESS"] }, dueAt: { lt: now } } }),
    prisma.workflowTimer.count({ where: { status: "PENDING", availableAt: { lte: now } } }),
    prisma.workflowInstance.findMany({ where: { status: "COMPLETED", startedAt: { not: null }, completedAt: { not: null } }, orderBy: { completedAt: "desc" }, take: 200, select: { startedAt: true, completedAt: true } }),
  ]);

  const toMap = (rows: { status: string; _count: { _all: number } }[]) => Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
  const instances = toMap(instByStatus);
  const lat = latencySample.map((r) => (r.completedAt && r.startedAt ? r.completedAt.getTime() - r.startedAt.getTime() : 0)).filter((n) => n >= 0);
  const avgLatencyMs = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0;

  const failed = instances.FAILED ?? 0;
  const pendingTimers = (timerByStatus.find((r) => r.status === "PENDING")?._count._all) ?? 0;
  let health: "HEALTHY" | "ATTENTION" | "CRITICAL" = "HEALTHY";
  if (failed >= 25 || overdueTasks >= 50) health = "CRITICAL";
  else if (failed >= 1 || overdueTasks >= 1 || dueTimers >= 1) health = "ATTENTION";

  return {
    instancesByStatus: instances,
    tasksByStatus: toMap(taskByStatus),
    timersByStatus: toMap(timerByStatus),
    activeDefinitions: activeDefs,
    overdueTasks,
    dueTimers,
    pendingTimers,
    failedInstances: failed,
    avgLatencyMs,
    health,
  };
}
