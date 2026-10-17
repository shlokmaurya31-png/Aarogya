import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import { createTask, closeTask, OPEN_STATUSES } from "@/lib/hospital/task";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

type CarePlanChange = "CREATED" | "INTERVENTION_ADDED" | "INTERVENTION_COMPLETED" | "CLOSED";

/** CarePlanUpdated (triage step 6), in the writer's transaction: what changed, never the clinician's text. */
async function emitCarePlanUpdated(tx: Prisma.TransactionClient, carePlanId: string, change: CarePlanChange, byUserId?: string, interventionId?: string) {
  const plan = await tx.carePlan.findUniqueOrThrow({ where: { id: carePlanId }, include: { _count: { select: { interventions: true } } } });
  await emitFacilityEvent(tx, {
    type: "CarePlanUpdated", aggregateId: plan.id, facilityId: plan.facilityId, actorUserId: byUserId, encounterId: plan.encounterId,
    payload: {
      carePlanId: plan.id, patientId: plan.patientId, change, status: plan.status, interventionCount: plan._count.interventions,
      ...(plan.encounterId ? { encounterId: plan.encounterId } : {}),
      ...(interventionId ? { interventionId } : {}),
    },
  });
}

/** Care plan (brief §6) — problem/goal/interventions. Never invents medical thresholds or protocols; goal/intervention text is entirely clinician-authored. */
export async function createCarePlan(input: {
  patientId: string;
  encounterId?: string;
  facilityId: string;
  problem: string;
  goal: string;
  priority?: "ROUTINE" | "URGENT" | "EMERGENCY";
  targetDate?: Date;
  createdByStaffId: string;
  notes?: string;
  interventions?: { description: string; responsibleRole: string }[];
  byUserId?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const plan = await tx.carePlan.create({
      data: {
        patientId: input.patientId,
        encounterId: input.encounterId,
        facilityId: input.facilityId,
        problem: input.problem,
        goal: input.goal,
        priority: input.priority,
        targetDate: input.targetDate,
        createdByStaffId: input.createdByStaffId,
        notes: input.notes,
        interventions: input.interventions?.length
          ? { create: input.interventions.map((i) => ({ description: i.description, responsibleRole: i.responsibleRole })) }
          : undefined,
      },
      include: { interventions: true },
    });
    await emitCarePlanUpdated(tx, plan.id, "CREATED", input.byUserId);
    return plan;
  });
}

/**
 * Adds an intervention to a care plan (brief §12/§23). Optionally spawns a
 * linked Task in the existing Task engine (`taskId`) rather than a second
 * parallel workflow — most interventions are documentary only and pass
 * `createTask: false`.
 */
export async function addIntervention(input: {
  carePlanId: string;
  facilityId: string;
  description: string;
  responsibleRole: string;
  createdByStaffId: string;
  byUserId: string;
  createTask?: boolean;
  taskDueAt?: Date;
}) {
  return prisma.$transaction(async (tx) => {
    const carePlan = await tx.carePlan.findUniqueOrThrow({ where: { id: input.carePlanId } });

    const intervention = await tx.carePlanIntervention.create({
      data: { carePlanId: input.carePlanId, description: input.description, responsibleRole: input.responsibleRole },
    });

    let linked = intervention;
    if (input.createTask) {
      const task = await createTask(tx, {
        facilityId: input.facilityId,
        title: input.description,
        type: "CARE_PLAN_INTERVENTION",
        patientId: carePlan.patientId,
        encounterId: carePlan.encounterId ?? undefined,
        dueAt: input.taskDueAt,
        source: "CARE_PLAN",
        createdByStaffId: input.createdByStaffId,
      }, input.byUserId);
      linked = await tx.carePlanIntervention.update({ where: { id: intervention.id }, data: { taskId: task.id } });
    }

    await tx.auditEvent.create({
      data: {
        type: "hospital.carePlan.interventionCreated",
        userId: input.byUserId,
        detail: { carePlanId: input.carePlanId, interventionId: intervention.id, taskId: linked.taskId ?? undefined },
        facilityId: input.facilityId,
        patientId: carePlan.patientId,
        encounterId: carePlan.encounterId ?? undefined,
      },
    });
    await emitCarePlanUpdated(tx, input.carePlanId, "INTERVENTION_ADDED", input.byUserId, intervention.id);
    return linked;
  });
}

/**
 * Completes an intervention (brief §12/§23/§24). Verifies the intervention
 * actually belongs to `carePlanId` before mutating it — the previous
 * `completeIntervention(interventionId)` trusted the client-supplied
 * interventionId with no ownership check, so any staff at the facility
 * could complete an intervention belonging to a *different* care plan (and
 * therefore potentially a different patient) as long as they knew its id.
 * If a Task is linked, it's completed transactionally in the same guarded
 * updateMany idiom as task.ts's completeTask, so the intervention and its
 * task can never end up in an inconsistent dual state.
 */
export async function completeIntervention(input: {
  interventionId: string;
  carePlanId: string;
  facilityId: string;
  completedByStaffId?: string;
  byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const intervention = await tx.carePlanIntervention.findUniqueOrThrow({ where: { id: input.interventionId } });
    if (intervention.carePlanId !== input.carePlanId) throw new NotFoundError("Intervention not found.");
    if (intervention.status === "COMPLETED" || intervention.status === "CANCELLED") {
      throw new BadRequestError(`This intervention is already ${intervention.status.toLowerCase()}.`);
    }

    const result = await tx.carePlanIntervention.updateMany({
      where: { id: input.interventionId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
      data: { status: "COMPLETED", completedAt: new Date() },
    });
    if (result.count !== 1) throw new BadRequestError(`This intervention is already ${intervention.status.toLowerCase()}.`);

    if (intervention.taskId) {
      const task = await tx.task.findUnique({ where: { id: intervention.taskId } });
      if (task && OPEN_STATUSES.includes(task.status)) {
        // Through the task service (D6), so TaskCompleted is emitted; it used a
        // raw update here, which closed the task without the event.
        const closed = await closeTask(tx, intervention.taskId, "COMPLETED", { completedByStaffId: input.completedByStaffId, completedByUserId: input.byUserId, completedAt: new Date() }, input.byUserId);
        if (closed) {
          await tx.auditEvent.create({
            data: {
              type: "hospital.task.completed",
              userId: input.byUserId,
              detail: { taskId: intervention.taskId, viaCarePlanIntervention: input.interventionId },
              facilityId: input.facilityId,
              patientId: task.patientId ?? undefined,
              encounterId: task.encounterId ?? undefined,
            },
          });
        }
      }
    }

    const updated = await tx.carePlanIntervention.findUniqueOrThrow({ where: { id: input.interventionId } });
    const carePlan = await tx.carePlan.findUniqueOrThrow({ where: { id: input.carePlanId } });
    await tx.auditEvent.create({
      data: {
        type: "hospital.carePlan.interventionCompleted",
        userId: input.byUserId,
        detail: { carePlanId: input.carePlanId, interventionId: input.interventionId },
        facilityId: input.facilityId,
        patientId: carePlan.patientId,
        encounterId: carePlan.encounterId ?? undefined,
      },
    });
    await emitCarePlanUpdated(tx, input.carePlanId, "INTERVENTION_COMPLETED", input.byUserId, input.interventionId);
    return updated;
  });
}

/** Closes an ACTIVE care plan (guarded: a closed plan can't be closed again, nor a concurrent close applied twice). */
export async function closeCarePlan(carePlanId: string, status: "COMPLETED" | "CANCELLED", byUserId?: string) {
  return prisma.$transaction(async (tx) => {
    const r = await tx.carePlan.updateMany({ where: { id: carePlanId, status: "ACTIVE" }, data: { status, completedAt: status === "COMPLETED" ? new Date() : undefined } });
    if (r.count !== 1) throw new BadRequestError("This care plan is already closed.");
    await emitCarePlanUpdated(tx, carePlanId, "CLOSED", byUserId);
    return tx.carePlan.findUniqueOrThrow({ where: { id: carePlanId } });
  });
}
