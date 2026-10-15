import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFoundError, ConflictError, BadRequestError } from "@/lib/auth/rbac";
import { createTask, closeTask, OPEN_STATUSES } from "@/lib/hospital/task";
import { assertNoSensitiveData } from "@/lib/events/sensitiveGuard";

type Tx = Prisma.TransactionClient;

/**
 * Phase D7 — orchestration tasks (§11/§12).
 *
 * A workflow task is a Task with source WORKFLOW (D6, workflow spine §4: one
 * Task model). It carries no clinical authority. Creation is idempotent on a
 * caller-supplied key (global for workflow tasks), and completion is a guarded,
 * idempotent state transition so a task cannot be completed twice with duplicate
 * downstream effect. TaskCreated / TaskCompleted come from the task service.
 *
 * Refuse, don't guess: a task needs a facility or an organization, and a patient
 * or encounter taken from an event payload must exist in the task's facility.
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
  const facilityId = input.facilityId ?? null;
  if (!facilityId && !input.organizationId) throw new BadRequestError("A workflow task needs a facility or an organization.");
  if ((input.patientId || input.encounterId) && !facilityId) throw new BadRequestError("A workflow task about a patient needs the facility the patient is in.");
  if (input.patientId) {
    const p = await tx.patient.findFirst({ where: { id: input.patientId, facilityId: facilityId! }, select: { id: true } });
    if (!p) throw new BadRequestError("The workflow event names a patient that is not in its facility.");
  }
  if (input.encounterId) {
    const e = await tx.encounter.findFirst({ where: { id: input.encounterId, facilityId: facilityId!, ...(input.patientId ? { patientId: input.patientId } : {}) }, select: { id: true } });
    if (!e) throw new BadRequestError("The workflow event names an encounter that is not in its facility.");
  }
  return createTask(tx, {
    source: "WORKFLOW",
    workflowInstanceId: input.workflowInstanceId, workflowStepId: input.workflowStepId ?? null,
    organizationId: input.organizationId ?? null, facilityId,
    patientId: input.patientId ?? null, encounterId: input.encounterId ?? null,
    type: input.taskType, title: input.title, description: input.description ?? null,
    priority: input.priority ?? "ROUTINE", status: "OPEN", assignedRole: input.assignedRole ?? null,
    dueAt: input.dueAt ?? null, idempotencyKey: input.idempotencyKey,
  });
}

/**
 * Complete a task. Guarded + idempotent: a concurrent double-completion yields a
 * single effective completion (one winner), and completing an already-terminal task
 * is a no-op that never double-applies downstream effects.
 */
export async function completeWorkflowTask(taskId: string, byUserId: string | null) {
  const task = await prisma.task.findFirst({ where: { id: taskId, source: "WORKFLOW" }, select: { id: true, status: true } });
  if (!task) throw new NotFoundError();
  if (!OPEN_STATUSES.includes(task.status)) {
    if (task.status === "COMPLETED") return prisma.task.findUniqueOrThrow({ where: { id: taskId } });
    throw new ConflictError(`Task cannot be completed from ${task.status}.`);
  }
  const done = await prisma.$transaction((tx) => closeTask(tx, taskId, "COMPLETED", { completedByUserId: byUserId, completedAt: new Date() }, byUserId));
  if (!done) throw new ConflictError("Task changed concurrently.");
  return done;
}

/** Cancel a task (guarded). Used by workflow cancellation and expiry. */
export async function cancelWorkflowTask(tx: Tx, taskId: string) {
  await closeTask(tx, taskId, "CANCELLED", { cancelledAt: new Date() });
}
