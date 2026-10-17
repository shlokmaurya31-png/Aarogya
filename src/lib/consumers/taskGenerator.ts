import type { Priority } from "@prisma/client";
import { prisma } from "@/lib/db";
import { createTask, closeTask as closeTaskTx, OPEN_STATUSES } from "@/lib/hospital/task";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { PermanentEventError, type DomainEventEnvelope } from "@/lib/events/types";
import { staffCanSeeDocument } from "@/lib/person/access";

/**
 * task-generator (workflow spine §2): creates and closes operational tasks in
 * reaction to events. Step 4: admission requests, ED dispositions and
 * discharge. Step 6: a STAT task per critical lab result / imaging report
 * (closed by CriticalResultAcknowledged) and a review task per missed dose.
 * Later steps add document review and requisitions.
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

/** A task about a patient with no encounter (e.g. a document from the portal), checked against the event's tenant. */
async function openPatientTask(event: DomainEventEnvelope, patientId: string, spec: TaskSpec) {
  const patient = await prisma.patient.findUnique({ where: { id: patientId }, select: { id: true, facilityId: true } });
  if (!patient || patient.facilityId !== event.facilityId) throw new PermanentEventError(`Patient ${patientId} is not in the event's facility.`, "TENANT_MISMATCH");
  await prisma.$transaction((tx) => createTask(tx, {
    facilityId: patient.facilityId, patientId: patient.id, type: spec.type, title: spec.title, priority: spec.priority ?? "ROUTINE",
    source: "EVENT", idempotencyKey: keyOf(spec.type, spec.sourceId),
  }));
}

async function closeTask(event: DomainEventEnvelope, type: string, sourceId: string, outcome: "COMPLETED" | "CANCELLED" = "COMPLETED") {
  await prisma.$transaction(async (tx) => {
    const task = await tx.task.findFirst({ where: { facilityId: event.facilityId!, idempotencyKey: keyOf(type, sourceId), source: "EVENT", status: { in: OPEN_STATUSES } }, select: { id: true } });
    if (task) await closeTaskTx(tx, task.id, outcome, outcome === "COMPLETED" ? { completedAt: event.occurredAt } : { cancelledAt: event.occurredAt });
  });
}

const ADMISSION_PRIORITY: Record<string, Priority> = { ROUTINE: "ROUTINE", URGENT: "URGENT", EMERGENCY: "STAT" };

const CRITICAL_RESULT = "CRITICAL_RESULT_FOLLOW_UP";

/**
 * A critical result or report opens a STAT task unless it was already
 * acknowledged (a lab result can be acknowledged before it is verified, so the
 * acknowledgement event may come first): the current state decides.
 */
async function openCriticalResultTask(event: DomainEventEnvelope) {
  const p = event.payload as { resultId?: string; reportId?: string; critical?: boolean };
  if (!p.critical) return;
  const row = p.resultId
    ? await prisma.labResult.findUnique({ where: { id: p.resultId }, select: { acknowledgedAt: true, labOrder: { select: { encounterId: true } } } }).then((r) => r && { acknowledgedAt: r.acknowledgedAt, encounterId: r.labOrder.encounterId })
    : await prisma.imagingReport.findUnique({ where: { id: p.reportId! }, select: { acknowledgedAt: true, imagingOrder: { select: { encounterId: true } } } }).then((r) => r && { acknowledgedAt: r.acknowledgedAt, encounterId: r.imagingOrder.encounterId });
  if (!row) throw new PermanentEventError(`Result ${p.resultId ?? p.reportId} not found.`, "NOT_FOUND");
  if (row.acknowledgedAt) return;
  return openTask(event, row.encounterId, {
    type: CRITICAL_RESULT, title: p.resultId ? "Acknowledge a critical lab result" : "Acknowledge a critical imaging report",
    priority: "STAT", sourceId: (p.resultId ?? p.reportId)!,
  });
}

/**
 * StockBelowReorder → one STOCK_REORDER task for procurement per item and
 * location while one is open (a later crossing, after stock was replenished
 * and fell again, opens a new one). URGENT when the location is out.
 */
async function openReorderTask(event: DomainEventEnvelope, p: { itemId: string; locationId: string; ledgerEntryId: string; onHandQty: number }) {
  const [item, location] = await Promise.all([
    prisma.item.findUnique({ where: { id: p.itemId }, select: { facilityId: true, name: true } }),
    prisma.stockLocation.findUnique({ where: { id: p.locationId }, select: { facilityId: true, name: true } }),
  ]);
  if (!item || !location || location.facilityId !== event.facilityId || (item.facilityId && item.facilityId !== event.facilityId)) {
    throw new PermanentEventError(`Item ${p.itemId} or location ${p.locationId} is not in the event's facility.`, "TENANT_MISMATCH");
  }
  const prefix = `STOCK_REORDER:${p.itemId}:${p.locationId}:`;
  await prisma.$transaction(async (tx) => {
    if (await tx.task.findFirst({ where: { facilityId: event.facilityId!, source: "EVENT", idempotencyKey: { startsWith: prefix }, status: { in: OPEN_STATUSES } }, select: { id: true } })) return;
    await createTask(tx, {
      facilityId: event.facilityId!, type: "STOCK_REORDER", title: `Reorder ${item.name} for ${location.name}`,
      priority: p.onHandQty <= 0 ? "URGENT" : "ROUTINE", assignedRole: "PROCUREMENT_OFFICER",
      source: "EVENT", idempotencyKey: `${prefix}${p.ledgerEntryId}`,
    });
  });
}

export const taskGenerator: DomainEventConsumer = {
  name: "task-generator",
  handles: [
    "AdmissionRequested", "BedReserved", "AdmissionRequestStatusChanged", "EdDispositionDecided", "DischargeInitiated", "PatientDischarged",
    "LabResultReleased", "ImagingReportReleased", "CriticalResultAcknowledged", "MedicationDoseMissed", "PatientDocumentUploaded",
    "StockBelowReorder",
  ],
  async handle(event) {
    const p = event.payload as Record<string, string>;
    switch (event.eventType) {
      case "AdmissionRequested":
        return openTask(event, p.encounterId, { type: "BED_ALLOCATION", title: "Allocate a bed for the admission request", priority: ADMISSION_PRIORITY[p.priority] ?? "ROUTINE", sourceId: p.admissionRequestId });
      case "BedReserved":
        return closeTask(event, "BED_ALLOCATION", p.admissionRequestId);
      case "AdmissionRequestStatusChanged":
        // A cancelled or rejected request needs no bed: its allocation task is cancelled.
        if (p.to === "CANCELLED" || p.to === "REJECTED") return closeTask(event, "BED_ALLOCATION", p.admissionRequestId, "CANCELLED");
        return;
      case "EdDispositionDecided": {
        const spec = DISPOSITION_TASKS[p.dispositionType];
        if (!spec) return;
        return openTask(event, p.encounterId, { ...spec, sourceId: p.dispositionId });
      }
      case "DischargeInitiated":
        return openTask(event, p.encounterId, { type: "DISCHARGE_PREP", title: "Prepare the patient for discharge", priority: "URGENT", sourceId: p.dischargeId });
      case "PatientDischarged":
        return closeTask(event, "DISCHARGE_PREP", p.dischargeId);
      case "LabResultReleased":
      case "ImagingReportReleased":
        return openCriticalResultTask(event);
      case "CriticalResultAcknowledged":
        return closeTask(event, CRITICAL_RESULT, p.resultId ?? p.reportId);
      case "PatientDocumentUploaded": {
        // Phase 0: the care team reviews an upload only if they may see it
        // (the owner's sharing choice + a care relationship, or a pre-Phase-0
        // upload). Otherwise not even its existence reaches them.
        const doc = await prisma.clinicalDocument.findUnique({ where: { id: p.documentId }, select: { id: true, patientId: true, uploadedByUserId: true, personId: true } });
        if (!doc || !event.facilityId || !(await staffCanSeeDocument(doc, event.facilityId))) return;
        return openPatientTask(event, p.patientId, { type: "DOCUMENT_REVIEW", title: "Review a document the patient uploaded", priority: "ROUTINE", sourceId: p.documentId });
      }
      case "StockBelowReorder":
        return openReorderTask(event, p as unknown as { itemId: string; locationId: string; ledgerEntryId: string; onHandQty: number });
      case "MedicationDoseMissed":
        if (!p.encounterId) return;
        return openTask(event, p.encounterId, { type: "MISSED_DOSE_REVIEW", title: "Review a dose that was not recorded", priority: "URGENT", sourceId: p.administrationId });
    }
  },
};
