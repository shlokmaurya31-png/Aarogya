import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { isEncounterTransitionAllowed } from "@/lib/hospital/encounterStateMachine";
import { EncounterStatus, BedStatus, type Prisma, type EdResuscitationStatus, type EdDispositionType, type AccessSource } from "@prisma/client";

/**
 * Emergency Department service (Phase B5). An ORCHESTRATION layer over the
 * canonical clinical core — an ED visit is a canonical Encounter (type=ED), and
 * triage/vitals/notes/tasks/nursing/diagnostics/meds/blood/handoffs/ADT are all
 * reused, never re-implemented. This file adds only the ED-specific mutations no
 * canonical record already carries. NO triage/severity/sepsis/AI algorithm —
 * every acuity/priority is a clinician-entered value the system only records.
 * Wrong-patient safe by construction: every child record derives
 * patient/encounter/facility from the parent Encounter, never from the client.
 */

// ── Arrival / registration ────────────────────────────────────────────────
export async function registerEdArrival(input: {
  facilityId: string; patientId: string; chiefComplaint?: string; accessSource?: AccessSource; arrivalMode?: string;
  referringProviderName?: string; referringFacilityName?: string; traumaIndicator?: boolean; ambulanceRef?: string;
  registeredByStaffId?: string; byUserId: string;
}) {
  const patient = await prisma.patient.findUnique({ where: { id: input.patientId } });
  if (!patient || patient.facilityId !== input.facilityId) throw new NotFoundError("Patient not found in this facility.");

  const encounter = await prisma.$transaction(async (tx) => {
    const enc = await tx.encounter.create({
      data: {
        facilityId: input.facilityId, patientId: input.patientId, type: "ED", status: "REGISTERED",
        chiefComplaint: input.chiefComplaint, accessSource: input.accessSource ?? "EMERGENCY", arrivalMode: input.arrivalMode,
        referringProviderName: input.referringProviderName, referringFacilityName: input.referringFacilityName,
        traumaIndicator: input.traumaIndicator ?? false, ambulanceRef: input.ambulanceRef,
      },
    });
    // Route into the canonical TRIAGE queue (reuses QueueEntry — no new queue engine).
    await tx.queueEntry.create({ data: { facilityId: input.facilityId, queueType: "TRIAGE", patientId: input.patientId, encounterId: enc.id, createdByStaffId: input.registeredByStaffId } });
    await tx.auditEvent.create({ data: { type: "hospital.ed.arrival", userId: input.byUserId, detail: { encounterId: enc.id, accessSource: enc.accessSource, chiefComplaint: input.chiefComplaint }, facilityId: input.facilityId, patientId: input.patientId, encounterId: enc.id } });
    return enc;
  });
  return encounter;
}

async function loadEdEncounter(tx: Prisma.TransactionClient, encounterId: string, facilityId: string) {
  const enc = await tx.encounter.findUnique({ where: { id: encounterId } });
  if (!enc || enc.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
  return enc;
}
function isTerminal(status: EncounterStatus) {
  return status === "DISCHARGED" || status === "CLOSED" || status === "CANCELLED";
}

// ── ED location (concurrency-safe; reuses Bed + EncounterLocation) ──────────
export class EdLocationConflictError extends BadRequestError {
  constructor(message = "That ED location was just taken. Refresh and try again.") { super(message); }
}

/**
 * Assign the encounter's current ED location. When `bedId` is given the Bed is
 * the concurrency point: a guarded AVAILABLE/RESERVED -> OCCUPIED CAS makes
 * "two users grab the same bay" single-winner, and the
 * encounter_location_one_active_per_encounter partial unique index makes
 * "one patient in two places" impossible. Releases (and frees the bed of) any
 * prior active location first.
 */
export async function assignEdLocation(input: { encounterId: string; facilityId: string; bedId?: string; areaLabel?: string; assignedByStaffId: string; byUserId: string }) {
  if (!input.bedId && !input.areaLabel) throw new BadRequestError("A bedId or areaLabel is required.");
  return prisma.$transaction(async (tx) => {
    const enc = await loadEdEncounter(tx, input.encounterId, input.facilityId);
    if (isTerminal(enc.status)) throw new BadRequestError("Cannot relocate a closed encounter.");

    // Release the prior active location (and free its bed).
    const prior = await tx.encounterLocation.findFirst({ where: { encounterId: input.encounterId, releasedAt: null }, orderBy: { assignedAt: "desc" } });
    if (prior) {
      await tx.encounterLocation.updateMany({ where: { encounterId: input.encounterId, releasedAt: null }, data: { releasedAt: new Date() } });
      if (prior.bedId) {
        const pb = await tx.bed.findUnique({ where: { id: prior.bedId } });
        if (pb && pb.status === "OCCUPIED") await tx.bed.updateMany({ where: { id: prior.bedId, status: "OCCUPIED" }, data: { status: "CLEANING" } });
      }
    }

    if (input.bedId) {
      const bed = await tx.bed.findUnique({ where: { id: input.bedId } });
      if (!bed || bed.facilityId !== input.facilityId) throw new NotFoundError("Bed not found in this facility.");
      if (bed.status !== BedStatus.AVAILABLE && bed.status !== BedStatus.RESERVED) throw new EdLocationConflictError("That ED bay is not available.");
      const cas = await tx.bed.updateMany({ where: { id: input.bedId, status: bed.status }, data: { status: BedStatus.OCCUPIED } });
      if (cas.count !== 1) throw new EdLocationConflictError();
      await tx.bedStateEvent.create({ data: { bedId: input.bedId, fromStatus: bed.status, toStatus: BedStatus.OCCUPIED, reason: "ED location assignment", byUserId: input.byUserId, patientId: enc.patientId, encounterId: input.encounterId } });
    }

    const location = await tx.encounterLocation.create({
      data: { encounterId: input.encounterId, facilityId: input.facilityId, bedId: input.bedId, areaLabel: input.bedId ? undefined : input.areaLabel, assignedByStaffId: input.assignedByStaffId },
    }).catch((e: unknown) => {
      // partial unique index backstop for a concurrent second assignment
      if (e instanceof Error && /unique/i.test(e.message)) throw new EdLocationConflictError();
      throw e;
    });

    await tx.auditEvent.create({ data: { type: "hospital.ed.locationAssigned", userId: input.byUserId, detail: { encounterId: input.encounterId, bedId: input.bedId, areaLabel: input.areaLabel }, facilityId: input.facilityId, patientId: enc.patientId, encounterId: input.encounterId } });
    return location;
  });
}

export async function releaseEdLocation(input: { encounterId: string; facilityId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const enc = await loadEdEncounter(tx, input.encounterId, input.facilityId);
    const prior = await tx.encounterLocation.findFirst({ where: { encounterId: input.encounterId, releasedAt: null } });
    if (!prior) return { released: false };
    await tx.encounterLocation.updateMany({ where: { encounterId: input.encounterId, releasedAt: null }, data: { releasedAt: new Date() } });
    if (prior.bedId) await tx.bed.updateMany({ where: { id: prior.bedId, status: "OCCUPIED" }, data: { status: "CLEANING" } });
    await tx.auditEvent.create({ data: { type: "hospital.ed.locationReleased", userId: input.byUserId, detail: { encounterId: input.encounterId, bedId: prior.bedId }, facilityId: input.facilityId, patientId: enc.patientId, encounterId: input.encounterId } });
    return { released: true };
  });
}

// ── Reassessment ────────────────────────────────────────────────────────────
export async function recordReassessment(input: { encounterId: string; facilityId: string; reassessedByStaffId: string; findings?: string; vitalId?: string; escalationRequired?: boolean; taskId?: string; byUserId: string }) {
  const enc = await prisma.encounter.findUnique({ where: { id: input.encounterId } });
  if (!enc || enc.facilityId !== input.facilityId) throw new NotFoundError("Encounter not found.");
  if (isTerminal(enc.status)) throw new BadRequestError("Cannot reassess a closed encounter.");
  const rec = await prisma.edReassessment.create({
    data: { encounterId: enc.id, facilityId: enc.facilityId, patientId: enc.patientId, reassessedByStaffId: input.reassessedByStaffId, findings: input.findings, vitalId: input.vitalId, taskId: input.taskId, escalationRequired: input.escalationRequired ?? false },
  });
  await recordAuditEvent("hospital.ed.reassessment", input.byUserId, { encounterId: enc.id, reassessmentId: rec.id, escalationRequired: rec.escalationRequired }, { facilityId: enc.facilityId, patientId: enc.patientId, encounterId: enc.id });
  return rec;
}

// ── High-acuity / resuscitation (explicit, never inferred) ──────────────────
export class EdResuscitationConflictError extends BadRequestError {
  constructor() { super("A resuscitation workflow is already active for this encounter."); }
}

export async function activateResuscitation(input: { encounterId: string; facilityId: string; activatedByStaffId: string; reason?: string; byUserId: string }) {
  const enc = await prisma.encounter.findUnique({ where: { id: input.encounterId } });
  if (!enc || enc.facilityId !== input.facilityId) throw new NotFoundError("Encounter not found.");
  if (isTerminal(enc.status)) throw new BadRequestError("Cannot activate resuscitation on a closed encounter.");
  const resus = await prisma.edResuscitation.create({
    data: { encounterId: enc.id, facilityId: enc.facilityId, patientId: enc.patientId, activatedByStaffId: input.activatedByStaffId, reason: input.reason, status: "ACTIVATED" },
  }).catch((e: unknown) => {
    // partial unique index (one open per encounter) → concurrent activation single-winner
    if (e instanceof Error && /unique/i.test(e.message)) throw new EdResuscitationConflictError();
    throw e;
  });
  await recordAuditEvent("hospital.ed.resuscitationActivated", input.byUserId, { encounterId: enc.id, resuscitationId: resus.id }, { facilityId: enc.facilityId, patientId: enc.patientId, encounterId: enc.id });
  return resus;
}

const RESUS_TRANSITIONS: Record<EdResuscitationStatus, EdResuscitationStatus[]> = {
  ACTIVATED: ["ACTIVE", "STABILIZED", "HANDED_OVER", "DISPOSITION_PENDING", "CLOSED"],
  ACTIVE: ["STABILIZED", "HANDED_OVER", "DISPOSITION_PENDING", "CLOSED"],
  STABILIZED: ["DISPOSITION_PENDING", "HANDED_OVER", "CLOSED"],
  HANDED_OVER: ["DISPOSITION_PENDING", "CLOSED"],
  DISPOSITION_PENDING: ["CLOSED"],
  CLOSED: [],
};

export async function updateResuscitation(input: { resuscitationId: string; facilityId: string; to: EdResuscitationStatus; actorStaffId: string; notes?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const resus = await tx.edResuscitation.findUnique({ where: { id: input.resuscitationId } });
    if (!resus || resus.facilityId !== input.facilityId) throw new NotFoundError("Resuscitation record not found.");
    if (!(RESUS_TRANSITIONS[resus.status]?.includes(input.to) ?? false)) throw new BadRequestError(`Illegal resuscitation transition ${resus.status} -> ${input.to}.`);
    const data: Prisma.EdResuscitationUpdateManyMutationInput = { status: input.to, ...(input.notes !== undefined ? { notes: input.notes } : {}) };
    if (input.to === "CLOSED") { data.closedByStaffId = input.actorStaffId; data.closedAt = new Date(); }
    const result = await tx.edResuscitation.updateMany({ where: { id: resus.id, status: resus.status }, data });
    if (result.count !== 1) throw new BadRequestError("Resuscitation state changed concurrently — refresh and try again.");
    await tx.auditEvent.create({ data: { type: "hospital.ed.resuscitationUpdated", userId: input.byUserId, detail: { resuscitationId: resus.id, from: resus.status, to: input.to }, facilityId: resus.facilityId, patientId: resus.patientId, encounterId: resus.encounterId } });
    return tx.edResuscitation.findUniqueOrThrow({ where: { id: resus.id } });
  });
}

// ── Disposition (single terminal winner via EdDisposition.encounterId unique) ─
export class EdDispositionConflictError extends BadRequestError {
  constructor() { super("This encounter has already been dispositioned."); }
}

const ADMIT_TYPES: EdDispositionType[] = ["ADMIT_WARD", "ADMIT_ICU"];
const CANCEL_TYPES: EdDispositionType[] = ["LWBS", "ABSCONDED"]; // never clinically seen through -> CANCELLED
const KEEP_OPEN_TYPES: EdDispositionType[] = ["TO_OT"]; // ED involvement ends but the encounter continues elsewhere

export async function dispositionEncounter(input: {
  encounterId: string; facilityId: string; type: EdDispositionType; dispositionedByStaffId: string;
  bedId?: string; admissionReason?: string; admissionType?: string; destinationDetail?: string; transferFacilityName?: string;
  reason?: string; note?: string; lastKnownLocation?: string; byUserId: string;
}) {
  if (ADMIT_TYPES.includes(input.type) && !input.bedId) throw new BadRequestError("A destination bedId is required to admit.");

  return prisma.$transaction(async (tx) => {
    const enc = await loadEdEncounter(tx, input.encounterId, input.facilityId);
    if (isTerminal(enc.status)) throw new BadRequestError("This encounter is already closed.");

    // Claim the single terminal disposition FIRST (unique encounterId) — this is
    // the single-winner barrier for concurrent/competing dispositions of any type.
    const disposition = await tx.edDisposition.create({
      data: {
        encounterId: enc.id, facilityId: enc.facilityId, patientId: enc.patientId, type: input.type,
        destinationDetail: input.destinationDetail, transferFacilityName: input.transferFacilityName,
        reason: input.reason, note: input.note, lastKnownLocation: input.lastKnownLocation, dispositionedByStaffId: input.dispositionedByStaffId,
      },
    }).catch((e: unknown) => {
      if (e instanceof Error && /unique/i.test(e.message)) throw new EdDispositionConflictError();
      throw e;
    });

    // Release any active ED location and free its bed (patient is leaving the ED bay).
    const prior = await tx.encounterLocation.findFirst({ where: { encounterId: enc.id, releasedAt: null } });
    if (prior) {
      await tx.encounterLocation.updateMany({ where: { encounterId: enc.id, releasedAt: null }, data: { releasedAt: new Date() } });
      // For an admit, the old ED bay is freed here; the new ward/ICU bed is occupied below.
      if (prior.bedId) await tx.bed.updateMany({ where: { id: prior.bedId, status: "OCCUPIED" }, data: { status: "CLEANING" } });
    }

    let admissionId: string | undefined;
    if (ADMIT_TYPES.includes(input.type)) {
      // Inline the canonical admission (same guarded-bed-CAS + Admission +
      // location + ADMITTED transition as admitPatient) so the whole disposition
      // is one atomic single-winner transaction. Reuses the canonical Bed/
      // Admission/EncounterLocation models — not a parallel admission entity.
      const bed = await tx.bed.findUnique({ where: { id: input.bedId! } });
      if (!bed || bed.facilityId !== input.facilityId) throw new NotFoundError("Destination bed not found in this facility.");
      if (bed.status !== BedStatus.AVAILABLE && bed.status !== BedStatus.RESERVED) throw new BadRequestError("Destination bed is not available.");
      if (!isEncounterTransitionAllowed(enc.status, EncounterStatus.ADMITTED)) throw new BadRequestError(`Cannot admit from status ${enc.status}.`);
      const cas = await tx.bed.updateMany({ where: { id: bed.id, status: bed.status }, data: { status: BedStatus.OCCUPIED } });
      if (cas.count !== 1) throw new EdLocationConflictError("Destination bed was just taken.");
      await tx.bedStateEvent.create({ data: { bedId: bed.id, fromStatus: bed.status, toStatus: BedStatus.OCCUPIED, reason: `ED admission: ${input.admissionReason ?? input.type}`, byUserId: input.byUserId, patientId: enc.patientId, encounterId: enc.id } });
      const admission = await tx.admission.create({ data: { encounterId: enc.id, bedId: bed.id, admittingStaffId: input.dispositionedByStaffId, reason: input.admissionReason ?? (input.type === "ADMIT_ICU" ? "ED admission to ICU" : "ED admission"), admissionType: input.admissionType ?? (input.type === "ADMIT_ICU" ? "EMERGENCY" : undefined) } });
      await tx.encounterLocation.create({ data: { encounterId: enc.id, facilityId: input.facilityId, bedId: bed.id, assignedByStaffId: input.dispositionedByStaffId } });
      await tx.encounter.updateMany({ where: { id: enc.id, status: enc.status }, data: { status: EncounterStatus.ADMITTED } });
      admissionId = admission.id;
      await tx.edDisposition.update({ where: { id: disposition.id }, data: { admissionId } });
    } else if (!KEEP_OPEN_TYPES.includes(input.type)) {
      // Terminal, non-admit: close the canonical encounter. LWBS/absconded ->
      // CANCELLED (never clinically seen through); everything else -> DISCHARGED,
      // falling back to CANCELLED when DISCHARGED isn't a legal transition (e.g.
      // a REGISTERED patient who left).
      let target: EncounterStatus = CANCEL_TYPES.includes(input.type) ? EncounterStatus.CANCELLED : EncounterStatus.DISCHARGED;
      if (!isEncounterTransitionAllowed(enc.status, target)) {
        if (isEncounterTransitionAllowed(enc.status, EncounterStatus.CANCELLED)) target = EncounterStatus.CANCELLED;
        else throw new BadRequestError(`Cannot disposition from status ${enc.status}.`);
      }
      const r = await tx.encounter.updateMany({
        where: { id: enc.id, status: enc.status },
        data: { status: target, closedAt: new Date(), ...(target === EncounterStatus.CANCELLED ? { cancelledReason: input.reason ?? input.type } : {}) },
      });
      if (r.count !== 1) throw new EdDispositionConflictError();
    }
    // KEEP_OPEN_TYPES (TO_OT): encounter stays active; the OT/surgery workflow drives it onward.

    await tx.auditEvent.create({ data: { type: "hospital.ed.disposition", userId: input.byUserId, detail: { encounterId: enc.id, type: input.type, admissionId }, facilityId: enc.facilityId, patientId: enc.patientId, encounterId: enc.id } });
    return tx.edDisposition.findUniqueOrThrow({ where: { id: disposition.id } });
  });
}

// ── Composition: command center, board, workspace, timeline ─────────────────
export async function buildEdCommandCenter(facilityId: string) {
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const activeWhere = { facilityId, type: "ED" as const, status: { notIn: [EncounterStatus.DISCHARGED, EncounterStatus.CLOSED, EncounterStatus.CANCELLED] } };
  const active = await prisma.encounter.findMany({
    where: activeWhere,
    include: {
      triageAssessments: { orderBy: { createdAt: "desc" }, take: 1 },
      locations: { where: { releasedAt: null }, take: 1, include: { bed: true } },
      edResuscitations: { where: { status: { not: "CLOSED" } }, take: 1 },
      labOrders: { where: { status: { notIn: ["RESULTED", "CANCELLED"] } }, select: { id: true } },
      imagingOrders: { where: { status: { notIn: ["REPORTED", "CANCELLED"] } }, select: { id: true } },
    },
  });
  const waitingTriage = active.filter((e) => e.triageAssessments.length === 0).length;
  const triaged = active.length - waitingTriage;
  const highAcuity = active.filter((e) => e.edResuscitations.length > 0 || (e.triageAssessments[0]?.acuity ?? 5) <= 2).length;
  const inTreatment = active.filter((e) => e.locations.length > 0).length;
  const pendingLab = active.filter((e) => e.labOrders.length > 0).length;
  const pendingImaging = active.filter((e) => e.imagingOrders.length > 0).length;
  const isolation = active.filter((e) => e.triageAssessments[0]?.isolationRequired || e.locations[0]?.bed?.isolationRequired).length;

  const [arrivalsToday, dispositionsToday] = await Promise.all([
    prisma.encounter.count({ where: { facilityId, type: "ED", registeredAt: { gte: startOfToday } } }),
    prisma.edDisposition.groupBy({ by: ["type"], where: { facilityId, dispositionAt: { gte: startOfToday } }, _count: { _all: true } }),
  ]);
  const dispositions = Object.fromEntries(dispositionsToday.map((d) => [d.type, d._count._all]));

  return {
    arrival: { arrivalsToday, waitingTriage, triageComplete: triaged },
    clinical: { active: active.length, highAcuity, inTreatment },
    diagnostics: { pendingLab, pendingImaging },
    operations: { occupiedEdBays: inTreatment, isolation },
    dispositionsToday: dispositions,
  };
}

export async function buildEdBoard(facilityId: string) {
  const encounters = await prisma.encounter.findMany({
    where: { facilityId, type: "ED", status: { notIn: [EncounterStatus.DISCHARGED, EncounterStatus.CLOSED, EncounterStatus.CANCELLED] } },
    include: {
      patient: true,
      attendingStaff: { include: { user: true } },
      triageAssessments: { where: { status: { not: "DRAFT" } }, orderBy: { createdAt: "desc" }, take: 1 },
      locations: { where: { releasedAt: null }, take: 1, include: { bed: { include: { ward: true } } } },
      edResuscitations: { where: { status: { not: "CLOSED" } }, take: 1 },
      labOrders: { where: { status: { notIn: ["RESULTED", "CANCELLED"] } }, select: { id: true } },
      imagingOrders: { where: { status: { notIn: ["REPORTED", "CANCELLED"] } }, select: { id: true } },
      admissionRequests: { where: { status: { notIn: ["ADMITTED", "REJECTED", "CANCELLED"] } }, select: { id: true }, take: 1 },
    },
    orderBy: { registeredAt: "asc" },
  });
  return encounters.map((e) => {
    const triage = e.triageAssessments[0];
    const location = e.locations[0];
    const resus = e.edResuscitations.length > 0;
    const column = resus ? "RESUSCITATION" : (triage?.assignedArea ?? (triage ? "STANDARD" : "TRIAGE_PENDING"));
    return {
      encounterId: e.id, patientId: e.patient.id, patientName: e.patient.fullName, uhid: e.patient.uhid,
      registeredAt: e.registeredAt, triageAcuity: triage?.acuity ?? e.triageLevel ?? null, column, status: e.status,
      location: location ? (location.bed ? `${location.bed.label} (${location.bed.ward.name})` : location.areaLabel) : null,
      attendingDoctor: e.attendingStaff?.user.displayName ?? null,
      waitMinutes: Math.round((Date.now() - e.registeredAt.getTime()) / 60_000),
      pendingLabOrders: e.labOrders.length, pendingImagingOrders: e.imagingOrders.length,
      admissionPending: e.admissionRequests.length > 0, resuscitation: resus,
      isolation: Boolean(triage?.isolationRequired || location?.bed?.isolationRequired),
      chiefComplaint: e.chiefComplaint,
    };
  });
}

export async function getEdWorkspace(encounterId: string, facilityId: string) {
  const encounter = await prisma.encounter.findUnique({
    where: { id: encounterId },
    include: {
      patient: true,
      attendingStaff: { include: { user: true } },
      triageAssessments: { orderBy: { createdAt: "desc" } },
      edReassessments: { orderBy: { createdAt: "desc" } },
      edResuscitations: { orderBy: { activatedAt: "desc" } },
      edDisposition: true,
      locations: { orderBy: { assignedAt: "desc" }, include: { bed: { include: { ward: true } } } },
      vitals: { orderBy: { recordedAt: "desc" }, take: 12 },
      notes: { include: { author: { include: { user: true } } }, orderBy: { createdAt: "desc" }, take: 10 },
      labOrders: { include: { results: { where: { isCurrent: true } } }, orderBy: { orderedAt: "desc" }, take: 12 },
      imagingOrders: { include: { reports: { where: { isCurrent: true } } }, orderBy: { orderedAt: "desc" }, take: 12 },
      medicationOrders: { orderBy: { orderedAt: "desc" }, take: 12 },
      handoffs: { orderBy: { createdAt: "desc" }, take: 8 },
      nursingAssignments: { where: { endAt: null }, include: { nurse: { include: { user: true } } } },
      bloodRequests: { orderBy: { requestedAt: "desc" }, take: 8 },
    },
  });
  if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
  return encounter;
}

export interface EdTimelineEntry { id: string; timestamp: string; type: string; summary: string; sourceType: string; sourceId: string }

export async function buildEdTimeline(encounterId: string, facilityId: string): Promise<EdTimelineEntry[]> {
  const enc = await prisma.encounter.findUnique({ where: { id: encounterId }, select: { id: true, facilityId: true } });
  if (!enc || enc.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");
  const [encounter, triage, reassessments, resus, locations, vitals, notes, labs, imaging, meds, handoffs, disposition, blood] = await Promise.all([
    prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } }),
    prisma.triageAssessment.findMany({ where: { encounterId } }),
    prisma.edReassessment.findMany({ where: { encounterId } }),
    prisma.edResuscitation.findMany({ where: { encounterId } }),
    prisma.encounterLocation.findMany({ where: { encounterId }, include: { bed: true } }),
    prisma.vital.findMany({ where: { encounterId }, orderBy: { recordedAt: "desc" }, take: 20 }),
    prisma.clinicalNote.findMany({ where: { encounterId } }),
    prisma.labOrder.findMany({ where: { encounterId } }),
    prisma.imagingOrder.findMany({ where: { encounterId } }),
    prisma.medicationOrder.findMany({ where: { encounterId } }),
    prisma.clinicalHandoff.findMany({ where: { encounterId } }),
    prisma.edDisposition.findUnique({ where: { encounterId } }),
    prisma.bloodRequest.findMany({ where: { encounterId } }),
  ]);
  const e: EdTimelineEntry[] = [];
  e.push({ id: `arr-${encounter.id}`, timestamp: encounter.registeredAt.toISOString(), type: "Arrival", summary: `ED arrival${encounter.chiefComplaint ? `: ${encounter.chiefComplaint}` : ""}`, sourceType: "Encounter", sourceId: encounter.id });
  for (const t of triage) e.push({ id: `tri-${t.id}`, timestamp: t.createdAt.toISOString(), type: "Triage", summary: `Triage acuity ${t.acuity}${t.assignedArea ? ` -> ${t.assignedArea}` : ""}${t.status === "AMENDED" ? " (amended)" : t.status === "DRAFT" ? " (draft)" : ""}`, sourceType: "TriageAssessment", sourceId: t.id });
  for (const l of locations) e.push({ id: `loc-${l.id}`, timestamp: l.assignedAt.toISOString(), type: "Location", summary: `Location: ${l.bed ? l.bed.label : l.areaLabel}`, sourceType: "EncounterLocation", sourceId: l.id });
  for (const r of resus) e.push({ id: `res-${r.id}`, timestamp: r.activatedAt.toISOString(), type: "Resuscitation", summary: `Resuscitation ${r.status}`, sourceType: "EdResuscitation", sourceId: r.id });
  for (const v of vitals) e.push({ id: `vit-${v.id}`, timestamp: v.recordedAt.toISOString(), type: "Vitals", summary: "Vitals recorded", sourceType: "Vital", sourceId: v.id });
  for (const n of notes) e.push({ id: `note-${n.id}`, timestamp: n.createdAt.toISOString(), type: "Note", summary: `${n.type} note (${n.status})`, sourceType: "ClinicalNote", sourceId: n.id });
  for (const r of reassessments) e.push({ id: `rea-${r.id}`, timestamp: r.createdAt.toISOString(), type: "Reassessment", summary: `Reassessment${r.escalationRequired ? " (escalation flagged)" : ""}`, sourceType: "EdReassessment", sourceId: r.id });
  for (const o of labs) e.push({ id: `lab-${o.id}`, timestamp: o.orderedAt.toISOString(), type: "Lab", summary: `Lab order (${o.status})`, sourceType: "LabOrder", sourceId: o.id });
  for (const o of imaging) e.push({ id: `img-${o.id}`, timestamp: o.orderedAt.toISOString(), type: "Imaging", summary: `Imaging order (${o.status})`, sourceType: "ImagingOrder", sourceId: o.id });
  for (const m of meds) e.push({ id: `med-${m.id}`, timestamp: m.orderedAt.toISOString(), type: "Medication", summary: `Medication: ${m.drugName}`, sourceType: "MedicationOrder", sourceId: m.id });
  for (const b of blood) e.push({ id: `bld-${b.id}`, timestamp: b.requestedAt.toISOString(), type: "Blood", summary: `Blood request: ${b.productName}`, sourceType: "BloodRequest", sourceId: b.id });
  for (const h of handoffs) e.push({ id: `ho-${h.id}`, timestamp: h.createdAt.toISOString(), type: "Handoff", summary: `${h.type} handoff (${h.status})`, sourceType: "ClinicalHandoff", sourceId: h.id });
  if (disposition) e.push({ id: `disp-${disposition.id}`, timestamp: disposition.dispositionAt.toISOString(), type: "Disposition", summary: `Disposition: ${disposition.type}`, sourceType: "EdDisposition", sourceId: disposition.id });
  return e.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
