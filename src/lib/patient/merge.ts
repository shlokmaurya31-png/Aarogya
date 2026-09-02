import { prisma } from "@/lib/db";

export class AlreadyMergedError extends Error {
  constructor() {
    super("One of these patients has already been merged.");
  }
}
export class SelfMergeError extends Error {
  constructor() {
    super("A patient cannot be merged into itself.");
  }
}
export class CrossFacilityMergeError extends Error {
  constructor() {
    super("Patients from different facilities cannot be merged.");
  }
}

/**
 * Logical merge (brief §10): never deletes or reassigns clinical rows.
 * Marks the source patient as merged into the target, records a
 * PatientMergeRecord for audit, and leaves every Encounter/Order/Note/etc.
 * exactly where it was — see readPatientIdsForChart() below for how a
 * merged patient's history becomes visible through the target.
 */
export async function mergePatients(input: {
  sourcePatientId: string;
  targetPatientId: string;
  actorStaffId: string;
  actorUserId: string;
  reason: string;
}) {
  if (input.sourcePatientId === input.targetPatientId) throw new SelfMergeError();

  const [source, target] = await Promise.all([
    prisma.patient.findUniqueOrThrow({ where: { id: input.sourcePatientId } }),
    prisma.patient.findUniqueOrThrow({ where: { id: input.targetPatientId } }),
  ]);

  if (source.mergedIntoId || target.mergedIntoId) throw new AlreadyMergedError();
  if (source.facilityId !== target.facilityId) throw new CrossFacilityMergeError();

  const record = await prisma.$transaction(async (tx) => {
    const created = await tx.patientMergeRecord.create({
      data: {
        sourcePatientId: input.sourcePatientId,
        targetPatientId: input.targetPatientId,
        actorStaffId: input.actorStaffId,
        reason: input.reason,
      },
    });
    await tx.patient.update({
      where: { id: input.sourcePatientId },
      data: { mergedIntoId: input.targetPatientId, mergedAt: new Date() },
    });
    // Audit write lives inside the same transaction as the merge itself —
    // both commit together or neither does, so a client never sees a
    // failure response for a merge that actually went through (see the
    // live-verification bug this fixed: FK violation here previously
    // surfaced as a 500 after the merge had already silently committed).
    await tx.auditEvent.create({
      data: {
        type: "hospital.patient.merged",
        userId: input.actorUserId,
        detail: { sourcePatientId: input.sourcePatientId, targetPatientId: input.targetPatientId, mergeRecordId: created.id },
      },
    });
    return created;
  });

  return record;
}

/**
 * Returns the target patient's id plus every id that has been merged into
 * it (transitively — a merged-into-a-merged patient chain is possible,
 * though unusual). Every clinical query that should show "the complete
 * story" (chart, timeline, summary) should use this instead of a bare
 * patientId, so a merge actually unifies the visible record without
 * physically touching any clinical row.
 */
export async function resolvePatientIdsForRead(patientId: string): Promise<string[]> {
  const ids = [patientId];
  const queue = [patientId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = await prisma.patient.findMany({ where: { mergedIntoId: current }, select: { id: true } });
    for (const c of children) {
      if (!ids.includes(c.id)) {
        ids.push(c.id);
        queue.push(c.id);
      }
    }
  }
  return ids;
}
