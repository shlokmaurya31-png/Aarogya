import { prisma } from "@/lib/db";
import { BedStatus, EncounterStatus } from "@prisma/client";
import { recordAuditEvent } from "@/lib/auth/audit";
import { isEncounterTransitionAllowed, InvalidEncounterTransitionError } from "./encounterStateMachine";
import { createPricedChargeIfNotExists } from "./billing/chargeCapture";
import { PriceNotFoundError } from "./billing/pricing";
import { ceilStayDays } from "./billing/money";
import { BedConcurrencyError } from "./bed";

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
  admissionType?: string;
  expectedLosDays?: number;
  byUserId: string;
}) {
  const { admission, auditContext } = await prisma.$transaction(async (tx) => {
    const bed = await tx.bed.findUniqueOrThrow({ where: { id: input.bedId } });
    // A bed reserved by THIS admission (via the Phase 2 AdmissionRequest flow,
    // src/lib/hospital/admissionRequest.ts) is also a legal starting state —
    // reservation exists precisely so staff can hold a bed ahead of the
    // patient physically arriving, without a second admission racing for it.
    if (bed.status !== BedStatus.AVAILABLE && bed.status !== BedStatus.RESERVED) throw new BedNotAvailableError();

    const encounter = await tx.encounter.findUniqueOrThrow({ where: { id: input.encounterId } });
    if (!isEncounterTransitionAllowed(encounter.status, EncounterStatus.ADMITTED)) {
      throw new InvalidEncounterTransitionError(encounter.status, EncounterStatus.ADMITTED);
    }

    // Guarded CAS: re-checks the status we just observed at write time so a
    // concurrent admitPatient/transferPatient racing for the same bed
    // between the read above and this write affects zero rows instead of
    // both silently succeeding into the same physical bed.
    const bedCas = await tx.bed.updateMany({ where: { id: input.bedId, status: bed.status }, data: { status: BedStatus.OCCUPIED } });
    if (bedCas.count !== 1) throw new BedConcurrencyError(input.bedId);
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
        admissionType: input.admissionType,
        expectedLosDays: input.expectedLosDays,
      },
    });

    // Location history (brief §20/§21) — the admission bed is the first
    // location for this encounter. transferPatient()/finalizeDischarge()
    // close and open EncounterLocation rows the same way, so the encounter
    // always has an auditable location timeline.
    await tx.encounterLocation.create({
      data: {
        encounterId: input.encounterId,
        facilityId: bed.facilityId,
        bedId: input.bedId,
        assignedByStaffId: input.admittingStaffId,
      },
    });

    await tx.encounter.update({ where: { id: input.encounterId }, data: { status: EncounterStatus.ADMITTED } });

    return { admission: created, auditContext: { facilityId: bed.facilityId, patientId: encounter.patientId } };
  });

  await recordAuditEvent(
    "hospital.admission.created",
    input.byUserId,
    { admissionId: admission.id, encounterId: input.encounterId, bedId: input.bedId, admissionType: input.admissionType },
    { ...auditContext, encounterId: input.encounterId }
  );

  return admission;
}

/** Transfer: releases the old bed to CLEANING, occupies the new one, all in one transaction. */
export async function transferPatient(input: {
  admissionId: string;
  toBedId: string;
  reason: string;
  byUserId: string;
}) {
  const { transfer, auditContext } = await prisma.$transaction(async (tx) => {
    const admission = await tx.admission.findUniqueOrThrow({ where: { id: input.admissionId }, include: { encounter: true } });
    const toBed = await tx.bed.findUniqueOrThrow({ where: { id: input.toBedId } });
    // Same reasoning as admitPatient() above — a bed this transfer itself reserved is legal.
    if (toBed.status !== BedStatus.AVAILABLE && toBed.status !== BedStatus.RESERVED) throw new BedNotAvailableError();

    const fromBed = await tx.bed.findUniqueOrThrow({ where: { id: admission.bedId } });

    const fromBedCas = await tx.bed.updateMany({ where: { id: fromBed.id, status: fromBed.status }, data: { status: BedStatus.CLEANING } });
    if (fromBedCas.count !== 1) throw new BedConcurrencyError(fromBed.id);
    await tx.bedStateEvent.create({
      data: { bedId: fromBed.id, fromStatus: fromBed.status, toStatus: BedStatus.CLEANING, reason: `Transfer out: ${input.reason}`, byUserId: input.byUserId },
    });

    const toBedCas = await tx.bed.updateMany({ where: { id: toBed.id, status: toBed.status }, data: { status: BedStatus.OCCUPIED } });
    if (toBedCas.count !== 1) throw new BedConcurrencyError(toBed.id);
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

    // Location history: close the current open location, open one at the
    // destination bed — so the encounter never shows two simultaneous
    // active locations.
    await tx.encounterLocation.updateMany({
      where: { encounterId: admission.encounterId, releasedAt: null },
      data: { releasedAt: new Date() },
    });
    await tx.encounterLocation.create({
      data: {
        encounterId: admission.encounterId,
        facilityId: toBed.facilityId,
        bedId: toBed.id,
        assignedByStaffId: admission.admittingStaffId,
      },
    });

    return { transfer: created, auditContext: { facilityId: admission.encounter.facilityId, patientId: admission.encounter.patientId, encounterId: admission.encounterId } };
  });

  await recordAuditEvent("hospital.admission.transferred", input.byUserId, { admissionId: input.admissionId, toBedId: input.toBedId }, auditContext);
  return transfer;
}

/** Initiates the discharge workflow (brief §36) — creates a Discharge row with readiness flags, all false initially. Does NOT free the bed yet; that happens at finalizeDischarge(). */
export async function initiateDischarge(admissionId: string, byUserId: string, initiatedByStaffId?: string) {
  const discharge = await prisma.discharge.create({ data: { admissionId, initiatedByStaffId } });
  const admission = await prisma.admission.findUnique({ where: { id: admissionId }, include: { encounter: true } });
  await recordAuditEvent(
    "hospital.discharge.initiated",
    byUserId,
    { admissionId },
    admission ? { facilityId: admission.encounter.facilityId, patientId: admission.encounter.patientId, encounterId: admission.encounterId } : undefined
  );
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
export async function finalizeDischarge(dischargeId: string, byUserId: string, dischargeSummary: unknown, dischargeType?: string) {
  const result = await prisma.$transaction(async (tx) => {
    const discharge = await tx.discharge.findUniqueOrThrow({ where: { id: dischargeId }, include: { admission: { include: { encounter: true } } } });
    const missing = (["clinicallyReady", "documentationReady", "billingReady", "insuranceReady", "pharmacyReady", "transportReady"] as const).filter(
      (k) => !discharge[k]
    );
    if (missing.length > 0) throw new DischargeNotReadyError(missing);
    if (!isEncounterTransitionAllowed(discharge.admission.encounter.status, EncounterStatus.DISCHARGED)) {
      throw new InvalidEncounterTransitionError(discharge.admission.encounter.status, EncounterStatus.DISCHARGED);
    }

    const bed = await tx.bed.findUniqueOrThrow({ where: { id: discharge.admission.bedId }, include: { ward: true } });
    const bedCas = await tx.bed.updateMany({ where: { id: bed.id, status: bed.status }, data: { status: BedStatus.CLEANING } });
    if (bedCas.count !== 1) throw new BedConcurrencyError(bed.id);
    await tx.bedStateEvent.create({
      data: { bedId: bed.id, fromStatus: bed.status, toStatus: BedStatus.CLEANING, reason: "Discharge", byUserId },
    });

    const dischargedAt = new Date();
    const updated = await tx.discharge.update({
      where: { id: dischargeId },
      data: { dischargedAt, signedByStaffId: byUserId, dischargeSummary: dischargeSummary as object, dischargeType },
    });

    // Location history: release the encounter's open location at discharge.
    await tx.encounterLocation.updateMany({
      where: { encounterId: discharge.admission.encounterId, releasedAt: null },
      data: { releasedAt: dischargedAt },
    });

    // Phase 5 — bed/accommodation billing. One bounded policy: any partial
    // day counts as a full day, priced against the bed's CURRENT ward type
    // only (mid-stay ward transfers are not separately priced this phase —
    // deliberately deferred, see docs/PHASE_5_SCOPE_AND_DEFERRALS.md).
    // Idempotent per admission via sourceType/sourceId — re-running
    // finalizeDischarge (it can't succeed twice, but defensively) never
    // double-charges.
    const daysStayed = ceilStayDays(discharge.admission.admittedAt, dischargedAt);
    const bedChargeCode = `BED_DAY:${bed.ward.wardType}`;
    try {
      await createPricedChargeIfNotExists(tx, {
        encounterId: discharge.admission.encounterId,
        patientId: discharge.admission.encounter.patientId,
        facilityId: discharge.admission.encounter.facilityId,
        description: `Bed charges: ${daysStayed} day(s), ${bed.ward.wardType}`,
        category: "BED",
        chargeCode: bedChargeCode,
        quantity: daysStayed,
        sourceType: "AdmissionBedDay",
        sourceId: discharge.admission.id,
        postedByUserId: byUserId,
      });
    } catch (err) {
      if (!(err instanceof PriceNotFoundError)) throw err;
      // No tariff configured for this ward type — documented gap, not a silent failure: discharge still proceeds, but no accommodation charge is posted.
    }

    await tx.encounter.update({
      where: { id: discharge.admission.encounterId },
      data: { status: EncounterStatus.DISCHARGED, closedAt: new Date() },
    });

    return {
      discharge: updated,
      auditContext: {
        facilityId: discharge.admission.encounter.facilityId,
        patientId: discharge.admission.encounter.patientId,
        encounterId: discharge.admission.encounterId,
      },
    };
  });

  await recordAuditEvent(
    "hospital.discharge.finalized",
    byUserId,
    { dischargeId, dischargeType },
    { facilityId: result.auditContext.facilityId, patientId: result.auditContext.patientId, encounterId: result.auditContext.encounterId }
  );
  return result.discharge;
}

/** Housekeeping completes cleaning -> bed becomes AVAILABLE (brief §50 bed<->housekeeping integration). */
export async function completeBedCleaning(bedId: string, byUserId: string) {
  const bed = await prisma.bed.findUniqueOrThrow({ where: { id: bedId } });
  if (bed.status !== BedStatus.CLEANING) throw new Error("Bed is not in CLEANING state.");
  // Guarded CAS + the status-flip and its BedStateEvent are now in one
  // transaction: previously these were two separate un-transacted calls, so
  // two concurrent housekeeping completions could both pass the CLEANING
  // check and both write (duplicate "cleaned" events), and a crash between
  // the two calls could leave a bed AVAILABLE with no event explaining why.
  const updated = await prisma.$transaction(async (tx) => {
    const cas = await tx.bed.updateMany({ where: { id: bedId, status: BedStatus.CLEANING }, data: { status: BedStatus.AVAILABLE } });
    if (cas.count !== 1) throw new BedConcurrencyError(bedId);
    await tx.bedStateEvent.create({
      data: { bedId, fromStatus: BedStatus.CLEANING, toStatus: BedStatus.AVAILABLE, reason: "Cleaning complete", byUserId },
    });
    return { ...bed, status: BedStatus.AVAILABLE };
  });
  await recordAuditEvent("hospital.bed.cleaned", byUserId, { bedId }, { facilityId: bed.facilityId });
  return updated;
}
