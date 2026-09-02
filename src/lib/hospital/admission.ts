import { prisma } from "@/lib/db";
import { BedStatus, EncounterStatus } from "@prisma/client";
import { recordAuditEvent } from "@/lib/auth/audit";
import { isEncounterTransitionAllowed, InvalidEncounterTransitionError } from "./encounterStateMachine";

export class BedNotAvailableError extends Error {
  constructor() {
    super("Selected bed is not available.");
  }
}

export { InvalidEncounterTransitionError };

/**
 * Admission is a single atomic operation across three tables (brief §129):
 * the bed flips to OCCUPIED, a BedStateEvent records why, and the Admission
 * row is created — all or nothing. If any step fails, nothing is left
 * half-applied (e.g. a bed marked occupied with no admission behind it).
 */
export async function admitPatient(input: {
  encounterId: string;
  bedId: string;
  admittingStaffId: string;
  reason: string;
  expectedLosDays?: number;
  byUserId: string;
}) {
  const admission = await prisma.$transaction(async (tx) => {
    const bed = await tx.bed.findUniqueOrThrow({ where: { id: input.bedId } });
    if (bed.status !== BedStatus.AVAILABLE) throw new BedNotAvailableError();

    const encounter = await tx.encounter.findUniqueOrThrow({ where: { id: input.encounterId } });
    if (!isEncounterTransitionAllowed(encounter.status, EncounterStatus.ADMITTED)) {
      throw new InvalidEncounterTransitionError(encounter.status, EncounterStatus.ADMITTED);
    }

    await tx.bed.update({ where: { id: input.bedId }, data: { status: BedStatus.OCCUPIED } });
    await tx.bedStateEvent.create({
      data: {
        bedId: input.bedId,
        fromStatus: bed.status,
        toStatus: BedStatus.OCCUPIED,
        reason: `Admission: ${input.reason}`,
        byUserId: input.byUserId,
        patientId: encounter.patientId,
        encounterId: input.encounterId,
      },
    });

    const created = await tx.admission.create({
      data: {
        encounterId: input.encounterId,
        bedId: input.bedId,
        admittingStaffId: input.admittingStaffId,
        reason: input.reason,
        expectedLosDays: input.expectedLosDays,
      },
    });

    await tx.encounter.update({ where: { id: input.encounterId }, data: { status: EncounterStatus.ADMITTED } });

    return created;
  });

  await recordAuditEvent("hospital.admission.created", input.byUserId, {
    admissionId: admission.id,
    encounterId: input.encounterId,
    bedId: input.bedId,
  });

  return admission;
}

/** Transfer: releases the old bed to CLEANING, occupies the new one, all in one transaction. */
export async function transferPatient(input: {
  admissionId: string;
  toBedId: string;
  reason: string;
  byUserId: string;
}) {
  const transfer = await prisma.$transaction(async (tx) => {
    const admission = await tx.admission.findUniqueOrThrow({ where: { id: input.admissionId } });
    const toBed = await tx.bed.findUniqueOrThrow({ where: { id: input.toBedId } });
    if (toBed.status !== BedStatus.AVAILABLE) throw new BedNotAvailableError();

    const fromBed = await tx.bed.findUniqueOrThrow({ where: { id: admission.bedId } });

    await tx.bed.update({ where: { id: fromBed.id }, data: { status: BedStatus.CLEANING } });
    await tx.bedStateEvent.create({
      data: { bedId: fromBed.id, fromStatus: fromBed.status, toStatus: BedStatus.CLEANING, reason: `Transfer out: ${input.reason}`, byUserId: input.byUserId },
    });

    await tx.bed.update({ where: { id: toBed.id }, data: { status: BedStatus.OCCUPIED } });
    await tx.bedStateEvent.create({
      data: { bedId: toBed.id, fromStatus: toBed.status, toStatus: BedStatus.OCCUPIED, reason: `Transfer in: ${input.reason}`, byUserId: input.byUserId },
    });

    const created = await tx.transfer.create({
      data: {
        admissionId: input.admissionId,
        fromBedId: fromBed.id,
        toBedId: toBed.id,
        reason: input.reason,
        byUserId: input.byUserId,
      },
    });

    await tx.admission.update({ where: { id: input.admissionId }, data: { bedId: toBed.id } });

    return created;
  });

  await recordAuditEvent("hospital.admission.transferred", input.byUserId, { admissionId: input.admissionId, toBedId: input.toBedId });
  return transfer;
}

/** Initiates the discharge workflow (brief §36) — creates a Discharge row with readiness flags, all false initially. Does NOT free the bed yet; that happens at finalizeDischarge(). */
export async function initiateDischarge(admissionId: string, byUserId: string) {
  const discharge = await prisma.discharge.create({ data: { admissionId } });
  await recordAuditEvent("hospital.discharge.initiated", byUserId, { admissionId });
  return discharge;
}

export async function updateDischargeReadiness(
  dischargeId: string,
  flags: Partial<Record<"clinicallyReady" | "documentationReady" | "billingReady" | "insuranceReady" | "pharmacyReady" | "transportReady", boolean>>
) {
  return prisma.discharge.update({ where: { id: dischargeId }, data: flags });
}

export class DischargeNotReadyError extends Error {
  constructor(missing: string[]) {
    super(`Discharge blocked — not ready: ${missing.join(", ")}`);
  }
}

/** Finalizes discharge: requires every readiness flag true, then frees the bed to CLEANING (brief §50 — bed workflow: discharged -> cleaning requested -> ... -> available). */
export async function finalizeDischarge(dischargeId: string, byUserId: string, dischargeSummary: unknown) {
  const result = await prisma.$transaction(async (tx) => {
    const discharge = await tx.discharge.findUniqueOrThrow({ where: { id: dischargeId }, include: { admission: { include: { encounter: true } } } });
    const missing = (["clinicallyReady", "documentationReady", "billingReady", "insuranceReady", "pharmacyReady", "transportReady"] as const).filter(
      (k) => !discharge[k]
    );
    if (missing.length > 0) throw new DischargeNotReadyError(missing);
    if (!isEncounterTransitionAllowed(discharge.admission.encounter.status, EncounterStatus.DISCHARGED)) {
      throw new InvalidEncounterTransitionError(discharge.admission.encounter.status, EncounterStatus.DISCHARGED);
    }

    const bed = await tx.bed.findUniqueOrThrow({ where: { id: discharge.admission.bedId } });
    await tx.bed.update({ where: { id: bed.id }, data: { status: BedStatus.CLEANING } });
    await tx.bedStateEvent.create({
      data: { bedId: bed.id, fromStatus: bed.status, toStatus: BedStatus.CLEANING, reason: "Discharge", byUserId },
    });

    const updated = await tx.discharge.update({
      where: { id: dischargeId },
      data: { dischargedAt: new Date(), signedByStaffId: byUserId, dischargeSummary: dischargeSummary as object },
    });

    await tx.encounter.update({
      where: { id: discharge.admission.encounterId },
      data: { status: EncounterStatus.DISCHARGED, closedAt: new Date() },
    });

    return updated;
  });

  await recordAuditEvent("hospital.discharge.finalized", byUserId, { dischargeId });
  return result;
}

/** Housekeeping completes cleaning -> bed becomes AVAILABLE (brief §50 bed<->housekeeping integration). */
export async function completeBedCleaning(bedId: string, byUserId: string) {
  const bed = await prisma.bed.findUniqueOrThrow({ where: { id: bedId } });
  if (bed.status !== BedStatus.CLEANING) throw new Error("Bed is not in CLEANING state.");
  const updated = await prisma.bed.update({ where: { id: bedId }, data: { status: BedStatus.AVAILABLE } });
  await prisma.bedStateEvent.create({
    data: { bedId, fromStatus: BedStatus.CLEANING, toStatus: BedStatus.AVAILABLE, reason: "Cleaning complete", byUserId },
  });
  await recordAuditEvent("hospital.bed.cleaned", byUserId, { bedId });
  return updated;
}
