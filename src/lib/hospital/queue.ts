import { prisma } from "@/lib/db";

/**
 * Generalized queue engine (brief §8-10). One `QueueEntry` table serves
 * every waiting line — registration, triage, a doctor's OPD queue, the ED
 * board — distinguished by `queueType`, rather than a bespoke table per
 * queue (see prisma/schema.prisma's QueueEntry doc comment).
 */

export interface PriorityInput {
  requestedPriority?: "ROUTINE" | "URGENT" | "EMERGENCY" | null;
  accessSource?: string | null;
  encounterType?: string | null;
  triageAcuity?: number | null;
  ageYears?: number | null;
  enteredAt: Date;
}

/**
 * Deterministic, fully explicit queue-priority scoring (brief §9) —
 * never an AI/ML judgment call. Lower score is seen sooner. Every factor
 * here is a plain, documented business rule; a recorded triage acuity
 * (once a clinician assigns it) dominates over the coarser access-source
 * heuristic used before triage.
 */
export function computeQueuePriority(input: PriorityInput): { score: number; reason: string } {
  let score = 100;
  const reasons: string[] = [];

  if (input.encounterType === "ED" || input.accessSource === "EMERGENCY") {
    score -= 40;
    reasons.push("ED/emergency arrival");
  }
  if (input.requestedPriority === "EMERGENCY") {
    score -= 30;
    reasons.push("marked EMERGENCY");
  } else if (input.requestedPriority === "URGENT") {
    score -= 15;
    reasons.push("marked URGENT");
  }

  if (input.triageAcuity != null) {
    // A recorded acuity is the strongest signal available (a clinician's own
    // judgment) — it can only make the entry more urgent than the heuristics above.
    score = Math.min(score, input.triageAcuity * 10);
    reasons.push(`triage acuity ${input.triageAcuity}`);
  }

  if (input.ageYears != null && (input.ageYears < 2 || input.ageYears >= 75)) {
    score -= 5;
    reasons.push("age-based priority (under 2 / 75+)");
  }

  const waitMinutes = (Date.now() - input.enteredAt.getTime()) / 60_000;
  if (waitMinutes > 30) {
    // Anti-starvation: a long-waiting low-priority patient slowly climbs the queue.
    const bonus = Math.min(20, Math.floor((waitMinutes - 30) / 10));
    if (bonus > 0) {
      score -= bonus;
      reasons.push(`long wait (${Math.round(waitMinutes)} min)`);
    }
  }

  return { score: Math.max(1, Math.round(score)), reason: reasons.join("; ") || "standard" };
}

export async function enterQueue(input: {
  facilityId: string;
  departmentId?: string;
  queueType: string;
  patientId: string;
  encounterId?: string;
  appointmentId?: string;
  practitionerStaffId?: string;
  requestedPriority?: "ROUTINE" | "URGENT" | "EMERGENCY";
  triageAcuity?: number | null;
  createdByStaffId?: string;
  byUserId: string;
}) {
  const patient = await prisma.patient.findUniqueOrThrow({ where: { id: input.patientId } });
  const encounter = input.encounterId ? await prisma.encounter.findUnique({ where: { id: input.encounterId } }) : null;
  const { score, reason } = computeQueuePriority({
    requestedPriority: input.requestedPriority,
    accessSource: encounter?.accessSource ?? null,
    encounterType: encounter?.type ?? null,
    triageAcuity: input.triageAcuity ?? null,
    ageYears: patient.ageYears,
    enteredAt: new Date(),
  });

  return prisma.$transaction(async (tx) => {
    const entry = await tx.queueEntry.create({
      data: {
        facilityId: input.facilityId,
        departmentId: input.departmentId,
        queueType: input.queueType,
        patientId: input.patientId,
        encounterId: input.encounterId,
        appointmentId: input.appointmentId,
        practitionerStaffId: input.practitionerStaffId,
        priorityScore: score,
        priorityReason: reason,
        createdByStaffId: input.createdByStaffId,
      },
    });
    await tx.auditEvent.create({
      data: { type: "hospital.queue.entered", userId: input.byUserId, detail: { queueEntryId: entry.id, queueType: input.queueType, patientId: input.patientId } },
    });
    return entry;
  });
}

/** Recomputes priority for an existing entry (e.g. after triage is recorded) — the queue is never silently reordered without a recorded reason (brief §23). */
export async function recomputeQueuePriority(queueEntryId: string, byUserId: string, extra?: { triageAcuity?: number }) {
  return prisma.$transaction(async (tx) => {
    const entry = await tx.queueEntry.findUniqueOrThrow({ where: { id: queueEntryId }, include: { patient: true, encounter: true } });
    const { score, reason } = computeQueuePriority({
      accessSource: entry.encounter?.accessSource ?? null,
      encounterType: entry.encounter?.type ?? null,
      triageAcuity: extra?.triageAcuity ?? null,
      ageYears: entry.patient.ageYears,
      enteredAt: entry.enteredAt,
    });
    const updated = await tx.queueEntry.update({ where: { id: queueEntryId }, data: { priorityScore: score, priorityReason: reason } });
    await tx.auditEvent.create({
      data: { type: "hospital.queue.priorityChanged", userId: byUserId, detail: { queueEntryId, score, reason } },
    });
    return updated;
  });
}

export class QueueEntryNotWaitingError extends Error {
  constructor() {
    super("Queue entry is not in a callable state.");
  }
}

/** Calls the next patient for a queue (optionally scoped to one practitioner) — lowest priorityScore, then longest-waiting, never a manual reorder. */
export async function callNext(facilityId: string, queueType: string, practitionerStaffId: string | undefined, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const entry = await tx.queueEntry.findFirst({
      where: { facilityId, queueType, status: "WAITING", ...(practitionerStaffId ? { practitionerStaffId } : {}) },
      orderBy: [{ priorityScore: "asc" }, { enteredAt: "asc" }],
      include: { patient: true },
    });
    if (!entry) return null;
    const updated = await tx.queueEntry.update({ where: { id: entry.id }, data: { status: "CALLED", calledAt: new Date() } });
    await tx.auditEvent.create({ data: { type: "hospital.queue.called", userId: byUserId, detail: { queueEntryId: updated.id, patientId: entry.patientId } } });
    return { ...updated, patient: entry.patient };
  });
}

export async function startService(queueEntryId: string) {
  const entry = await prisma.queueEntry.findUniqueOrThrow({ where: { id: queueEntryId } });
  if (entry.status !== "WAITING" && entry.status !== "CALLED") throw new QueueEntryNotWaitingError();
  return prisma.queueEntry.update({ where: { id: queueEntryId }, data: { status: "IN_SERVICE", startedAt: entry.startedAt ?? new Date() } });
}

export async function completeQueueEntry(queueEntryId: string, byUserId: string) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.queueEntry.update({ where: { id: queueEntryId }, data: { status: "COMPLETED", completedAt: new Date() } });
    await tx.auditEvent.create({ data: { type: "hospital.queue.completed", userId: byUserId, detail: { queueEntryId } } });
    return updated;
  });
}

export async function skipQueueEntry(queueEntryId: string) {
  return prisma.queueEntry.update({ where: { id: queueEntryId }, data: { status: "SKIPPED" } });
}

export async function cancelQueueEntry(queueEntryId: string) {
  return prisma.queueEntry.update({ where: { id: queueEntryId }, data: { status: "CANCELLED" } });
}

/** Estimated wait computed at read time from queue position, never persisted (avoids staleness) — brief §10. avgServiceMinutes is a coarse, configurable placeholder, not a measured facility statistic yet. */
export function estimateWaitMinutes(position: number, avgServiceMinutes = 12): number {
  return Math.max(0, position) * avgServiceMinutes;
}
