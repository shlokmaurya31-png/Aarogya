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
export class NotMergedError extends Error {
  constructor() {
    super("This patient is not currently merged into another, so there is nothing to unmerge.");
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
    // Guarded CAS: flip the source's mergedIntoId only while it's still
    // null, inside the transaction. Two concurrent merges of the same
    // source (the read-time check above is TOCTOU-prone under READ
    // COMMITTED) can now only have one winner — the loser's updateMany
    // affects zero rows and throws, instead of both committing a
    // contradictory survivor/merged state (brief §25).
    const cas = await tx.patient.updateMany({
      where: { id: input.sourcePatientId, mergedIntoId: null },
      data: { mergedIntoId: input.targetPatientId, mergedAt: new Date() },
    });
    if (cas.count !== 1) throw new AlreadyMergedError();

    // Guard the target too: it must not itself have become merged (a
    // concurrent merge could have made the intended survivor a non-survivor).
    const targetNow = await tx.patient.findUniqueOrThrow({ where: { id: input.targetPatientId } });
    if (targetNow.mergedIntoId) throw new AlreadyMergedError();

    const created = await tx.patientMergeRecord.create({
      data: {
        sourcePatientId: input.sourcePatientId,
        targetPatientId: input.targetPatientId,
        actorStaffId: input.actorStaffId,
        reason: input.reason,
      },
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
 * Reverses a logical merge (brief §10). Safe precisely because mergePatients
 * never reassigned or deleted any clinical row — it only set the source's
 * mergedIntoId/mergedAt — so clearing those fields fully restores the two
 * patients as independent records with zero risk of orphaned/duplicated
 * references. Guarded CAS (mergedIntoId must currently be non-null) so two
 * concurrent unmerges can't both "succeed", and the PatientMergeRecord is
 * retained as history rather than deleted.
 */
export async function unmergePatients(input: {
  patientId: string;
  actorStaffId: string;
  actorUserId: string;
  reason: string;
}) {
  const patient = await prisma.patient.findUniqueOrThrow({ where: { id: input.patientId } });
  if (!patient.mergedIntoId) throw new NotMergedError();

  return prisma.$transaction(async (tx) => {
    const cas = await tx.patient.updateMany({
      where: { id: input.patientId, mergedIntoId: { not: null } },
      data: { mergedIntoId: null, mergedAt: null },
    });
    if (cas.count !== 1) throw new NotMergedError();

    await tx.auditEvent.create({
      data: {
        type: "hospital.patient.unmerged",
        userId: input.actorUserId,
        detail: { patientId: input.patientId, previousTargetId: patient.mergedIntoId, reason: input.reason },
        facilityId: patient.facilityId,
        patientId: input.patientId,
      },
    });
    return tx.patient.findUniqueOrThrow({ where: { id: input.patientId } });
  });
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
