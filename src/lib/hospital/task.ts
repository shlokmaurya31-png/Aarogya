import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";

const TERMINAL_STATUSES = ["COMPLETED", "CANCELLED"];
const NOT_TERMINAL = { notIn: TERMINAL_STATUSES };

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

    const result = await tx.task.updateMany({
      where: { id: input.taskId, status: NOT_TERMINAL },
      data: { status: "COMPLETED", completedByStaffId: input.completedByStaffId, completedAt: new Date() },
    });
    if (result.count !== 1) throw new TaskConcurrencyError(task.status);
    const updated = await tx.task.findUniqueOrThrow({ where: { id: input.taskId } });

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

    const result = await tx.task.updateMany({
      where: { id: input.taskId, status: NOT_TERMINAL },
      data: { status: "CANCELLED", skippedAt: new Date(), skipReason: input.skipReason },
    });
    if (result.count !== 1) throw new TaskConcurrencyError(task.status);
    const updated = await tx.task.findUniqueOrThrow({ where: { id: input.taskId } });

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
    if (input.status && TERMINAL_STATUSES.includes(input.status)) {
      throw new BadRequestError("Use completeTask/skipTask to move a task into a terminal state.");
    }

    const result = await tx.task.updateMany({
      where: { id: input.taskId, status: NOT_TERMINAL },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.ownerStaffId !== undefined ? { ownerStaffId: input.ownerStaffId } : {}),
        ...(input.startedAt ? { startedAt: new Date() } : {}),
      },
    });
    if (result.count !== 1) throw new TaskConcurrencyError(task.status);
    return tx.task.findUniqueOrThrow({ where: { id: input.taskId } });
  });
}
