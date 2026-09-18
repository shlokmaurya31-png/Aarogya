import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFoundError, BadRequestError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { type ActorMemberships } from "@/lib/auth/tenantContext";
import { requireWorkflowPlatform, assertCanReadWorkflowScope } from "./authz";
import { cancelInstanceTimersTx } from "./timers";
import { runInstance } from "./engine";

/**
 * Phase D7 — workflow instance operations (§17/§18): scoped reads, platform-only
 * cancellation and manual retry/recovery. Cancellation stops future work and
 * cancels pending timers/tasks while preserving execution history; retry is
 * idempotent (manual + automatic retry converge via the guarded instance claim).
 */

export async function getInstance(m: ActorMemberships, instanceId: string) {
  const inst = await prisma.workflowInstance.findUnique({
    where: { id: instanceId },
    include: {
      steps: { orderBy: { stepIndex: "asc" } },
      tasks: { orderBy: { createdAt: "asc" } },
      timers: { orderBy: { availableAt: "asc" } },
      definition: { select: { key: true, name: true } },
    },
  });
  if (!inst) throw new NotFoundError();
  assertCanReadWorkflowScope(m, inst.organizationId);
  return inst;
}

export async function listInstances(m: ActorMemberships, opts?: { organizationId?: string; status?: string; workflowDefinitionId?: string; limit?: number }) {
  const where: Prisma.WorkflowInstanceWhereInput = {};
  if (opts?.status) where.status = opts.status;
  if (opts?.workflowDefinitionId) where.workflowDefinitionId = opts.workflowDefinitionId;
  if (m.isPlatformAdmin) {
    if (opts?.organizationId) where.organizationId = opts.organizationId;
  } else {
    where.organizationId = { in: [...m.orgMemberships.keys()] };
  }
  return prisma.workflowInstance.findMany({ where, orderBy: { createdAt: "desc" }, take: Math.min(opts?.limit ?? 100, 500), include: { definition: { select: { key: true, name: true } } } });
}

const NON_TERMINAL = ["RUNNABLE", "RUNNING", "WAITING"];

/** Platform-only cancellation. Guarded so a concurrent execution converges to CANCELLED. */
export async function cancelInstance(m: ActorMemberships, instanceId: string, reason: string) {
  requireWorkflowPlatform(m);
  const inst = await prisma.workflowInstance.findUnique({ where: { id: instanceId }, select: { id: true, organizationId: true, status: true } });
  if (!inst) throw new NotFoundError();
  if (!NON_TERMINAL.includes(inst.status)) throw new BadRequestError(`Cannot cancel a ${inst.status} workflow.`);
  await prisma.$transaction(async (tx) => {
    const res = await tx.workflowInstance.updateMany({
      where: { id: instanceId, status: { in: NON_TERMINAL } },
      data: { status: "CANCELLED", claimToken: null, cancelledAt: new Date(), cancelledByUserId: m.userId, cancelReason: reason },
    });
    if (res.count !== 1) throw new ConflictError("Workflow changed concurrently.");
    await tx.workflowStep.updateMany({ where: { workflowInstanceId: instanceId, status: { in: ["PENDING", "WAITING"] } }, data: { status: "SKIPPED" } });
    await cancelInstanceTimersTx(tx, instanceId);
    await tx.workflowTask.updateMany({ where: { workflowInstanceId: instanceId, status: { in: ["OPEN", "IN_PROGRESS"] } }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await recordAuditEvent("workflow.instance.cancelled", m.userId, { instanceId, reason }, { organizationId: inst.organizationId ?? undefined }, tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
  return getInstance(m, instanceId);
}

/**
 * Platform-only manual retry/recovery of a FAILED instance. Resets the failed
 * step(s) and re-arms the instance; the guarded instance claim makes this idempotent
 * even against a concurrent automatic retry (both converge to one execution).
 */
export async function retryInstance(m: ActorMemberships, instanceId: string, opts?: { recover?: boolean; reason?: string }) {
  requireWorkflowPlatform(m);
  const inst = await prisma.workflowInstance.findUnique({ where: { id: instanceId }, select: { id: true, organizationId: true, status: true } });
  if (!inst) throw new NotFoundError();
  if (inst.status !== "FAILED") throw new BadRequestError("Only a FAILED workflow can be retried.");
  await prisma.$transaction(async (tx) => {
    const res = await tx.workflowInstance.updateMany({ where: { id: instanceId, status: "FAILED" }, data: { status: "RUNNABLE", claimToken: null, failedAt: null, failureCategory: null, failureMessage: null } });
    if (res.count !== 1) throw new ConflictError("Workflow changed concurrently.");
    await tx.workflowStep.updateMany({ where: { workflowInstanceId: instanceId, status: "FAILED" }, data: { status: "PENDING", availableAt: new Date(), attemptCount: 0, failureCategory: null, failureMessage: null } });
    await recordAuditEvent(opts?.recover ? "workflow.instance.recovered" : "workflow.instance.retried", m.userId, { instanceId, reason: opts?.reason ?? null }, { organizationId: inst.organizationId ?? undefined }, tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000, maxWait: 10000 });
  await runInstance(instanceId);
  return getInstance(m, instanceId);
}
