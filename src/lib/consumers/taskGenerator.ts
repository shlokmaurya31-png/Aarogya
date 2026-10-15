import type { Priority } from "@prisma/client";
import { prisma } from "@/lib/db";
import { createTask, closeTask as closeTaskTx, OPEN_STATUSES } from "@/lib/hospital/task";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { PermanentEventError, type DomainEventEnvelope } from "@/lib/events/types";

/**
 * task-generator (workflow spine §2): creates and closes operational tasks in
 * reaction to ADT events. Step 4 scope: admission requests, ED dispositions and
 * discharge. Later steps add critical results, missed doses, document review.
 *
 * Idempotent: every task has a key derived from its source
 * ("<TASK_TYPE>:<source id>"), unique per facility, so redelivery creates
 * nothing; closing is a guarded update of the open task with that key. Tasks
 * are created and closed through the task service, so TaskCreated /
 * TaskCompleted are emitted once (D6).
 * Re-reads what it needs and checks the event's tenant on every row.
 */
type TaskSpec = { type: string; title: string; priority?: Priority; sourceId: string };

const DISPOSITION_TASKS: Record<string, { type: string; title: string; priority: Priority } | undefined> = {
  ADMIT_WARD: { type: "WARD_HANDOVER", title: "Receive admission from the ED", priority: "URGENT" },
  ADMIT_ICU: { type: "WARD_HANDOVER", title: "Receive ICU admission from the ED", priority: "STAT" },
  TRANSFER_OUT: { type: "INTERFACILITY_TRANSFER", title: "Arrange transfer to another facility", priority: "URGENT" },
  LAMA: { type: "ED_FOLLOW_UP", title: "Follow up: patient left against medical advice", priority: "URGENT" },
  DAMA: { type: "ED_FOLLOW_UP", title: "Follow up: discharged against medical advice", priority: "URGENT" },
  LWBS: { type: "ED_FOLLOW_UP", title: "Follow up: patient left without being seen", priority: "URGENT" },
  ABSCONDED: { type: "ED_FOLLOW_UP", title: "Follow up: patient absconded", priority: "STAT" },
  DECEASED: { type: "DEATH_DOCUMENTATION", title: "Complete death documentation", priority: "URGENT" },
};

const keyOf = (type: string, sourceId: string) => `${type}:${sourceId}`;

/** The encounter the event is about, checked against the event's tenant. */
async function encounterIn(event: DomainEventEnvelope, encounterId: string) {
  const enc = await prisma.encounter.findUnique({ where: { id: encounterId }, select: { id: true, facilityId: true, patientId: true } });
  if (!enc || enc.facilityId !== event.facilityId) {
    throw new PermanentEventError(`Encounter ${encounterId} is not in the event's facility.`, "TENANT_MISMATCH");
  }
  return enc;
}

async function openTask(event: DomainEventEnvelope, encounterId: string, spec: TaskSpec) {
  const enc = await encounterIn(event, encounterId);
  await prisma.$transaction((tx) => createTask(tx, {
    facilityId: enc.facilityId, patientId: enc.patientId, encounterId: enc.id,
    type: spec.type, title: spec.title, priority: spec.priority ?? "ROUTINE",
    source: "EVENT", idempotencyKey: keyOf(spec.type, spec.sourceId),
  }));
}

async function closeTask(event: DomainEventEnvelope, type: string, sourceId: string) {
  await prisma.$transaction(async (tx) => {
    const task = await tx.task.findFirst({ where: { facilityId: event.facilityId!, idempotencyKey: keyOf(type, sourceId), source: "EVENT", status: { in: OPEN_STATUSES } }, select: { id: true } });
    if (task) await closeTaskTx(tx, task.id, "COMPLETED", { completedAt: event.occurredAt });
  });
}

const ADMISSION_PRIORITY: Record<string, Priority> = { ROUTINE: "ROUTINE", URGENT: "URGENT", EMERGENCY: "STAT" };

export const taskGenerator: DomainEventConsumer = {
  name: "task-generator",
  handles: ["AdmissionRequested", "BedReserved", "EdDispositionDecided", "DischargeInitiated", "PatientDischarged"],
  async handle(event) {
    const p = event.payload as Record<string, string>;
    switch (event.eventType) {
      case "AdmissionRequested":
        return openTask(event, p.encounterId, { type: "BED_ALLOCATION", title: "Allocate a bed for the admission request", priority: ADMISSION_PRIORITY[p.priority] ?? "ROUTINE", sourceId: p.admissionRequestId });
      case "BedReserved":
        return closeTask(event, "BED_ALLOCATION", p.admissionRequestId);
      case "EdDispositionDecided": {
        const spec = DISPOSITION_TASKS[p.dispositionType];
        if (!spec) return;
        return openTask(event, p.encounterId, { ...spec, sourceId: p.dispositionId });
      }
      case "DischargeInitiated":
        return openTask(event, p.encounterId, { type: "DISCHARGE_PREP", title: "Prepare the patient for discharge", priority: "URGENT", sourceId: p.dischargeId });
      case "PatientDischarged":
        return closeTask(event, "DISCHARGE_PREP", p.dischargeId);
    }
  },
};
