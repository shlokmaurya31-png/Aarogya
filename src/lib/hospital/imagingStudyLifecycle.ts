import { Prisma, ImagingStudyStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { generateAccessionNumber } from "./accessionNumber";

type Tx = Prisma.TransactionClient;

/**
 * Imaging study state machine (brief §6-8). NO_SHOW is declared on the
 * enum (matching real scheduling vocabulary) but has no route this
 * milestone — same "declared, not invented" discipline as elsewhere.
 */
const STUDY_ALLOWED: Record<ImagingStudyStatus, ImagingStudyStatus[]> = {
  SCHEDULED: ["ARRIVED", "CANCELLED"],
  ARRIVED: ["IN_PROGRESS"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

export class InvalidStudyTransitionError extends BadRequestError {
  constructor(from: ImagingStudyStatus, to: ImagingStudyStatus) {
    super(`Illegal imaging study transition: ${from} -> ${to}`);
  }
}

/** Thrown when a guarded concurrent update affects zero rows — someone else won the race. */
export class StudyConcurrencyError extends BadRequestError {
  constructor(action: string) {
    super(`Study was already ${action} by someone else, or is no longer in the expected state. Refresh and try again.`);
  }
}

/**
 * Resource double-booking guard (brief §8, §23) — mirrors
 * src/lib/hospital/appointment.ts's exact idiom: count existing
 * non-cancelled bookings at the same resource+exact-timestamp inside the
 * caller's transaction, throw if any exist. This is an app-level check
 * relying on SQLite's transaction serialization, NOT a DB-level guarantee
 * — same documented limitation as appointment.ts (see that file's
 * comment). On Postgres this should be strengthened with
 * `SELECT ... FOR UPDATE` on the resource row or a partial unique index
 * on (resourceId, scheduledAt) WHERE status NOT IN ('CANCELLED','NO_SHOW').
 */
export class ScheduleConflictError extends BadRequestError {
  constructor() {
    super("This resource already has a study scheduled at that time (slot is full).");
  }
}

export function isStudyTransitionAllowed(from: ImagingStudyStatus, to: ImagingStudyStatus): boolean {
  return STUDY_ALLOWED[from]?.includes(to) ?? false;
}

export async function scheduleStudy(
  tx: Tx,
  input: {
    imagingOrderId: string;
    facilityId: string;
    patientId: string;
    encounterId: string;
    modality: string;
    bodyRegion?: string;
    resourceId?: string | null;
    scheduledAt: Date;
    contrastRequired?: boolean;
  }
) {
  if (input.resourceId) {
    const overlapping = await tx.imagingStudy.count({
      where: { resourceId: input.resourceId, scheduledAt: input.scheduledAt, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
    });
    if (overlapping > 0) throw new ScheduleConflictError();
  }

  const study = await tx.imagingStudy.create({
    data: {
      imagingOrderId: input.imagingOrderId,
      facilityId: input.facilityId,
      patientId: input.patientId,
      encounterId: input.encounterId,
      modality: input.modality,
      bodyRegion: input.bodyRegion,
      resourceId: input.resourceId ?? undefined,
      scheduledAt: input.scheduledAt,
      status: "SCHEDULED",
      accessionNumber: generateAccessionNumber("RAD"),
      contrastRequired: input.contrastRequired ?? false,
    },
  });

  await tx.imagingOrder.updateMany({ where: { id: input.imagingOrderId, status: "ORDERED" }, data: { status: "SCHEDULED" } });
  return study;
}

/** Reschedule (brief §8) — only while still SCHEDULED; re-runs the conflict check against the new slot. */
export async function rescheduleStudy(tx: Tx, studyId: string, resourceId: string | null, scheduledAt: Date) {
  const study = await tx.imagingStudy.findUniqueOrThrow({ where: { id: studyId } });
  if (study.status !== "SCHEDULED") throw new InvalidStudyTransitionError(study.status, "SCHEDULED");

  if (resourceId) {
    const overlapping = await tx.imagingStudy.count({
      where: { id: { not: studyId }, resourceId, scheduledAt, status: { notIn: ["CANCELLED", "NO_SHOW"] } },
    });
    if (overlapping > 0) throw new ScheduleConflictError();
  }

  const result = await tx.imagingStudy.updateMany({ where: { id: studyId, status: "SCHEDULED" }, data: { resourceId: resourceId ?? undefined, scheduledAt } });
  if (result.count !== 1) throw new StudyConcurrencyError("rescheduled");
  return tx.imagingStudy.findUniqueOrThrow({ where: { id: studyId } });
}

async function guardedTransition(tx: Tx, studyId: string, from: ImagingStudyStatus, to: ImagingStudyStatus, data: Record<string, unknown>, actionLabel: string) {
  const result = await tx.imagingStudy.updateMany({ where: { id: studyId, status: from }, data: { status: to, ...data } });
  if (result.count !== 1) throw new StudyConcurrencyError(actionLabel);
  return tx.imagingStudy.findUniqueOrThrow({ where: { id: studyId } });
}

export async function checkInStudy(tx: Tx, studyId: string) {
  return guardedTransition(tx, studyId, "SCHEDULED", "ARRIVED", { arrivedAt: new Date() }, "checked in");
}

/** "Claim" a study for execution (brief §23 concurrency test #1) — the first technologist to call this wins. */
export async function startStudy(
  tx: Tx,
  studyId: string,
  performedByStaffId: string,
  screening: { pregnancyScreened?: boolean; allergyScreened?: boolean; mriSafetyScreened?: boolean; implantScreened?: boolean; preparationCompleted?: boolean } = {}
) {
  return guardedTransition(tx, studyId, "ARRIVED", "IN_PROGRESS", { startedAt: new Date(), performedByStaffId, ...screening }, "claimed");
}

export async function completeStudy(tx: Tx, studyId: string, input: { contrastGiven?: boolean; notes?: string } = {}) {
  const study = await guardedTransition(tx, studyId, "IN_PROGRESS", "COMPLETED", { performedAt: new Date(), contrastGiven: input.contrastGiven ?? false, notes: input.notes }, "completed");
  await tx.imagingOrder.updateMany({ where: { id: study.imagingOrderId, status: "SCHEDULED" }, data: { status: "ACQUIRED" } });
  return study;
}

export async function cancelStudy(tx: Tx, studyId: string, reason: string) {
  const study = await tx.imagingStudy.findUniqueOrThrow({ where: { id: studyId } });
  if (!isStudyTransitionAllowed(study.status, "CANCELLED")) throw new InvalidStudyTransitionError(study.status, "CANCELLED");
  const result = await tx.imagingStudy.updateMany({ where: { id: studyId, status: study.status }, data: { status: "CANCELLED", cancelledReason: reason } });
  if (result.count !== 1) throw new StudyConcurrencyError("cancelled");
  return tx.imagingStudy.findUniqueOrThrow({ where: { id: studyId } });
}

/** Facility-scoped fetch, used by every study-action route before transitioning. */
export async function findStudyInFacility(studyId: string, facilityId: string) {
  const study = await prisma.imagingStudy.findUnique({ where: { id: studyId } });
  if (!study || study.facilityId !== facilityId) throw new NotFoundError("Imaging study not found.");
  return study;
}
