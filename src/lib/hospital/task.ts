import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";
import { $Enums, type Prisma, type Task, type TaskStatus } from "@prisma/client";
import { parseOptionalEnum } from "@/lib/enumValue";
import { emitDomainEvent } from "@/lib/events/emit";
import { facilityOrganizationId } from "@/lib/events/tenant";

type Tx = Prisma.TransactionClient;

export const TERMINAL_STATUSES: TaskStatus[] = ["COMPLETED", "CANCELLED", "EXPIRED"];
export const OPEN_STATUSES: TaskStatus[] = ["OPEN", "ASSIGNED", "IN_PROGRESS"];
const NOT_TERMINAL = { notIn: TERMINAL_STATUSES };

/**
 * D6 (workflow spine §4): every task, whatever created it (a clinician, a care
 * plan, an order, an event consumer, a workflow), is a Task row created and
 * closed here, so TaskCreated / TaskCompleted are emitted exactly once, in the
 * writer's transaction.
 */
async function taskEvent(tx: Tx, task: Task, type: "TaskCreated" | "TaskCompleted", payload: Record<string, unknown>, actorUserId?: string | null) {
  const organizationId = task.facilityId ? await facilityOrganizationId(tx, task.facilityId) : task.organizationId;
  return {
    type, aggregateId: task.id, organizationId, facilityId: task.facilityId, actorUserId: actorUserId ?? null,
    correlationId: task.encounterId ?? undefined, payload,
  };
}

/**
 * Create a task and emit TaskCreated. With an idempotencyKey, a second call is a
 * no-op that returns the existing task and emits nothing (keys are unique per
 * facility; workflow keys are global).
 */
export async function createTask(tx: Tx, data: Prisma.TaskUncheckedCreateInput, actorUserId?: string | null): Promise<Task> {
  let task: Task;
  if (data.idempotencyKey) {
    const { count } = await tx.task.createMany({ data: [data], skipDuplicates: true });
    task = await tx.task.findFirstOrThrow({
      where: { idempotencyKey: data.idempotencyKey, source: data.source, ...(data.source === "WORKFLOW" ? {} : { facilityId: data.facilityId ?? null }) },
    });
    if (count === 0) return task;
  } else {
    task = await tx.task.create({ data });
  }
  await emitDomainEvent(tx, await taskEvent(tx, task, "TaskCreated", {
    taskId: task.id, source: task.source, taskType: task.type, priority: task.priority,
    ...(task.patientId ? { patientId: task.patientId } : {}),
    ...(task.encounterId ? { encounterId: task.encounterId } : {}),
    ...(task.dueAt ? { dueAt: task.dueAt.toISOString() } : {}),
  }, actorUserId));
  return task;
}

/**
 * Move an open task to COMPLETED or CANCELLED (guarded: only from an open
 * status) and emit TaskCompleted. Returns the task, or null when it was not
 * open (already closed, or closed concurrently) — nothing is emitted then.
 */
export async function closeTask(
  tx: Tx,
  taskId: string,
  outcome: "COMPLETED" | "CANCELLED",
  data: Omit<Prisma.TaskUncheckedUpdateManyInput, "status">,
  actorUserId?: string | null,
): Promise<Task | null> {
  const res = await tx.task.updateMany({ where: { id: taskId, status: { in: OPEN_STATUSES } }, data: { ...data, status: outcome } });
  if (res.count !== 1) return null;
  const task = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
  await emitDomainEvent(tx, await taskEvent(tx, task, "TaskCompleted", { taskId: task.id, source: task.source, outcome }, actorUserId));
  return task;
}

export class TaskConcurrencyError extends BadRequestError {
  constructor(status: string) {
    super(`This task is already ${status} — cannot apply this change again. Refresh and try again.`);
  }
}

/**
 * Completes a task (brief §11/§24-A). Concurrency-safe via a guarded
 * updateMany (status not already terminal in the WHERE, count-checked
 * after) — the same CAS idiom medicationLifecycle.ts/bed.ts/purchaseOrders.ts
 * use everywhere else, replacing the previous plain `update()` that let two
 * concurrent completions both "succeed" and both fire an audit event.
 */
export async function completeTask(input: {
  taskId: string;
  facilityId: string;
  completedByStaffId?: string;
  byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.findUniqueOrThrow({ where: { id: input.taskId } });
    if (TERMINAL_STATUSES.includes(task.status)) throw new TaskConcurrencyError(task.status);

    const updated = await closeTask(tx, input.taskId, "COMPLETED", { completedByStaffId: input.completedByStaffId, completedByUserId: input.byUserId, completedAt: new Date() }, input.byUserId);
    if (!updated) throw new TaskConcurrencyError(task.status);

    await tx.auditEvent.create({
      data: {
        type: "hospital.task.completed",
        userId: input.byUserId,
        detail: { taskId: input.taskId },
        facilityId: input.facilityId,
        patientId: task.patientId ?? undefined,
        encounterId: task.encounterId ?? undefined,
      },
    });
    return updated;
  });
}

/** Skips/cancels a task. Same guarded updateMany idiom as completeTask. */
export async function skipTask(input: {
  taskId: string;
  facilityId: string;
  skipReason: string;
  byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.findUniqueOrThrow({ where: { id: input.taskId } });
    if (TERMINAL_STATUSES.includes(task.status)) throw new TaskConcurrencyError(task.status);

    const now = new Date();
    const updated = await closeTask(tx, input.taskId, "CANCELLED", { skippedAt: now, cancelledAt: now, skipReason: input.skipReason }, input.byUserId);
    if (!updated) throw new TaskConcurrencyError(task.status);

    await tx.auditEvent.create({
      data: {
        type: "hospital.task.skipped",
        userId: input.byUserId,
        detail: { taskId: input.taskId, skipReason: input.skipReason },
        facilityId: input.facilityId,
        patientId: task.patientId ?? undefined,
        encounterId: task.encounterId ?? undefined,
      },
    });
    return updated;
  });
}

/**
 * Non-completion updates (owner reassignment, marking in-progress, or a
 * plain status change between non-terminal states). Still guarded against
 * operating on a task that has already reached a terminal state — the
 * pre-existing route allowed e.g. COMPLETED -> OPEN with no check at all.
 */
export async function updateTask(input: {
  taskId: string;
  facilityId: string;
  status?: string;
  ownerStaffId?: string | null;
  startedAt?: boolean;
}) {
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.findUniqueOrThrow({ where: { id: input.taskId } });
    if (TERMINAL_STATUSES.includes(task.status)) throw new TaskConcurrencyError(task.status);
    const status = parseOptionalEnum($Enums.TaskStatus, input.status, "status");
    if (status && TERMINAL_STATUSES.includes(status)) {
      throw new BadRequestError("Use completeTask/skipTask to move a task into a terminal state.");
    }

    const result = await tx.task.updateMany({
      where: { id: input.taskId, status: NOT_TERMINAL },
      data: {
        ...(status ? { status } : {}),
        ...(input.ownerStaffId !== undefined ? { ownerStaffId: input.ownerStaffId } : {}),
        ...(input.startedAt ? { startedAt: new Date() } : {}),
      },
    });
    if (result.count !== 1) throw new TaskConcurrencyError(task.status);
    return tx.task.findUniqueOrThrow({ where: { id: input.taskId } });
  });
}
