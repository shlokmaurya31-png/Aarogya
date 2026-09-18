import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { assertNoSensitiveData } from "@/lib/events/sensitiveGuard";

type Tx = Prisma.TransactionClient;

/**
 * Phase D7 — orchestration tasks (§11/§12).
 *
 * WorkflowTask is an operational to-do created by a workflow. It is NOT the
 * clinical Task (which requires a staff creator + facility and carries clinical
 * coupling); a workflow task carries no clinical authority. Creation is idempotent
 * on a caller-supplied key, and completion is a guarded, idempotent state
 * transition so a task cannot be completed twice with duplicate downstream effect.
 */

export interface CreateWorkflowTaskInput {
  workflowInstanceId: string;
  workflowStepId?: string | null;
  organizationId?: string | null;
  facilityId?: string | null;
  patientId?: string | null;
  encounterId?: string | null;
  taskType: string;
  title: string;
  description?: string | null;
  priority?: "ROUTINE" | "URGENT" | "STAT";
  assignedRole?: string | null;
  dueAt?: Date | null;
  idempotencyKey: string;
}

/** Idempotently create an orchestration task in the given transaction. */
export async function createWorkflowTask(tx: Tx, input: CreateWorkflowTaskInput) {
  // Defense in depth: task metadata must not smuggle secrets/PHI blobs.
  assertNoSensitiveData({ title: input.title, description: input.description ?? undefined, taskType: input.taskType });
  try {
    return await tx.workflowTask.create({
      data: {
        workflowInstanceId: input.workflowInstanceId, workflowStepId: input.workflowStepId ?? null,
        organizationId: input.organizationId ?? null, facilityId: input.facilityId ?? null,
        patientId: input.patientId ?? null, encounterId: input.encounterId ?? null,
        taskType: input.taskType, title: input.title, description: input.description ?? null,
        priority: input.priority ?? "ROUTINE", status: "OPEN", assignedRole: input.assignedRole ?? null,
        dueAt: input.dueAt ?? null, idempotencyKey: input.idempotencyKey,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002") throw err;
    return tx.workflowTask.findUniqueOrThrow({ where: { idempotencyKey: input.idempotencyKey } });
  }
}

const OPEN_TASK_STATES = ["OPEN", "IN_PROGRESS"];

/**
 * Complete a task. Guarded + idempotent: a concurrent double-completion yields a
 * single effective completion (one winner), and completing an already-terminal task
 * is a no-op that never double-applies downstream effects.
 */
export async function completeWorkflowTask(taskId: string, byUserId: string | null) {
  const task = await prisma.workflowTask.findUnique({ where: { id: taskId }, select: { id: true, status: true } });
  if (!task) throw new NotFoundError();
  if (!OPEN_TASK_STATES.includes(task.status)) {
    if (task.status === "COMPLETED") return prisma.workflowTask.findUniqueOrThrow({ where: { id: taskId } });
    throw new ConflictError(`Task cannot be completed from ${task.status}.`);
  }
  const res = await prisma.workflowTask.updateMany({
    where: { id: taskId, status: { in: OPEN_TASK_STATES } },
    data: { status: "COMPLETED", completedByUserId: byUserId, completedAt: new Date() },
  });
  if (res.count !== 1) throw new ConflictError("Task changed concurrently.");
  return prisma.workflowTask.findUniqueOrThrow({ where: { id: taskId } });
}

/** Cancel a task (guarded). Used by workflow cancellation and expiry. */
export async function cancelWorkflowTask(tx: Tx, taskId: string) {
  await tx.workflowTask.updateMany({ where: { id: taskId, status: { in: OPEN_TASK_STATES } }, data: { status: "CANCELLED", cancelledAt: new Date() } });
}
