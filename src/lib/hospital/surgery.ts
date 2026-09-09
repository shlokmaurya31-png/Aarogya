import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { issueStock } from "@/lib/hospital/inventory/issue";
import type { Prisma, SurgeryStatus, AnesthesiaType } from "@prisma/client";

/**
 * Operating Theatre & Surgical Workflow service (Phase B3). Composes the
 * canonical Patient/Encounter/ADT/ClinicalNote/Item-stock systems — no
 * parallel domain models. Every surgical mutation validates
 * patient/encounter/facility alignment server-side; specimen/implant
 * patient/encounter/facility are DERIVED from the parent Surgery (never
 * client-supplied). No clinical scoring/dosing/decision logic.
 */

// ── Surgery state machine ─────────────────────────────────────────────────
const SURGERY_TRANSITIONS: Record<SurgeryStatus, SurgeryStatus[]> = {
  REQUESTED: ["REVIEWED", "CANCELLED"],
  REVIEWED: ["APPROVED", "CANCELLED"],
  APPROVED: ["SCHEDULED", "CANCELLED"],
  SCHEDULED: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
};

export class SurgeryTransitionError extends BadRequestError {
  constructor(from: string, to: string) {
    super(`Illegal surgery transition ${from} -> ${to}.`);
  }
}
export class SurgeryScheduleConflictError extends BadRequestError {
  constructor() {
    super("This operating theatre is already booked for an overlapping time. Refresh and try again.");
  }
}

export function isSurgeryTransitionAllowed(from: SurgeryStatus, to: SurgeryStatus): boolean {
  return SURGERY_TRANSITIONS[from]?.includes(to) ?? false;
}

// ── Config: procedures + theatres ─────────────────────────────────────────
export async function createProcedure(input: { facilityId: string; code: string; name: string; description?: string; specialty?: string; typicalDurationMinutes?: number; byUserId: string }) {
  const proc = await prisma.procedure.create({
    data: { facilityId: input.facilityId, code: input.code, name: input.name, description: input.description, specialty: input.specialty, typicalDurationMinutes: input.typicalDurationMinutes },
  });
  await recordAuditEvent("hospital.ot.procedureConfigured", input.byUserId, { procedureId: proc.id, code: proc.code }, { facilityId: input.facilityId });
  return proc;
}

export async function createOperatingTheatre(input: { facilityId: string; name: string; type?: string; departmentId?: string; capabilities?: unknown; byUserId: string }) {
  const ot = await prisma.operatingTheatre.create({
    data: { facilityId: input.facilityId, name: input.name, type: input.type, departmentId: input.departmentId, capabilities: (input.capabilities ?? undefined) as Prisma.InputJsonValue | undefined },
  });
  await recordAuditEvent("hospital.ot.theatreConfigured", input.byUserId, { operatingTheatreId: ot.id, name: ot.name }, { facilityId: input.facilityId });
  return ot;
}

// ── Surgery request + lifecycle ───────────────────────────────────────────
export async function requestSurgery(input: {
  facilityId: string; patientId: string; encounterId: string; procedureId?: string; procedureName?: string;
  indication?: string; laterality?: string; urgency?: string; requestedDate?: Date; requestedByStaffId: string; byUserId: string;
}) {
  const encounter = await prisma.encounter.findUnique({ where: { id: input.encounterId } });
  if (!encounter || encounter.facilityId !== input.facilityId || encounter.patientId !== input.patientId) throw new NotFoundError("Encounter not found for this patient/facility.");
  if (encounter.status === "CLOSED" || encounter.status === "CANCELLED") throw new BadRequestError("Cannot request surgery against a closed encounter.");

  let procedureName = input.procedureName;
  if (input.procedureId) {
    const proc = await prisma.procedure.findUnique({ where: { id: input.procedureId } });
    if (!proc || proc.facilityId !== input.facilityId) throw new NotFoundError("Procedure not found.");
    procedureName = procedureName ?? proc.name;
  }
  if (!procedureName) throw new BadRequestError("procedureId or procedureName is required.");

  const surgery = await prisma.surgery.create({
    data: {
      facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId,
      procedureId: input.procedureId, procedureName, indication: input.indication, laterality: input.laterality,
      urgency: input.urgency ?? "ELECTIVE", requestedByStaffId: input.requestedByStaffId, requestedDate: input.requestedDate,
    },
  });
  await recordAuditEvent("hospital.ot.surgeryRequested", input.byUserId, { surgeryId: surgery.id, procedureName }, { facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId });
  return surgery;
}

/** Guarded lifecycle transition (REVIEWED/APPROVED/CANCELLED and start/complete go through dedicated fns). */
export async function transitionSurgery(input: { surgeryId: string; facilityId: string; to: SurgeryStatus; actorStaffId: string; reason?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const surgery = await tx.surgery.findUnique({ where: { id: input.surgeryId } });
    if (!surgery || surgery.facilityId !== input.facilityId) throw new NotFoundError("Surgery not found.");
    if (!isSurgeryTransitionAllowed(surgery.status, input.to)) throw new SurgeryTransitionError(surgery.status, input.to);

    const data: Prisma.SurgeryUpdateManyMutationInput = { status: input.to };
    if (input.to === "REVIEWED") { data.reviewedByStaffId = input.actorStaffId; data.reviewedAt = new Date(); }
    if (input.to === "APPROVED") { data.approvedByStaffId = input.actorStaffId; data.approvedAt = new Date(); }
    if (input.to === "CANCELLED") { data.cancelledReason = input.reason ?? "Cancelled"; data.cancelledAt = new Date(); }

    const result = await tx.surgery.updateMany({ where: { id: input.surgeryId, status: surgery.status }, data });
    if (result.count !== 1) throw new SurgeryTransitionError(surgery.status, input.to);

    // Cancelling a scheduled surgery frees its OT slot.
    if (input.to === "CANCELLED") {
      await tx.surgerySchedule.updateMany({ where: { surgeryId: input.surgeryId, status: "SCHEDULED" }, data: { status: "CANCELLED" } });
    }

    await tx.auditEvent.create({ data: { type: "hospital.ot.surgeryStatusChanged", userId: input.byUserId, detail: { surgeryId: input.surgeryId, from: surgery.status, to: input.to }, facilityId: surgery.facilityId, patientId: surgery.patientId, encounterId: surgery.encounterId } });
    return tx.surgery.findUniqueOrThrow({ where: { id: input.surgeryId } });
  });
}

// ── Scheduling (overlap-safe) ─────────────────────────────────────────────
export async function scheduleSurgery(input: { surgeryId: string; facilityId: string; operatingTheatreId: string; startAt: Date; endAt: Date; schedulerStaffId: string; notes?: string; byUserId: string }) {
  if (input.endAt <= input.startAt) throw new BadRequestError("End must be after start.");
  return prisma.$transaction(async (tx) => {
    const surgery = await tx.surgery.findUnique({ where: { id: input.surgeryId } });
    if (!surgery || surgery.facilityId !== input.facilityId) throw new NotFoundError("Surgery not found.");
    if (!(surgery.status === "APPROVED" || surgery.status === "SCHEDULED")) throw new BadRequestError(`Only an APPROVED surgery can be scheduled (current: ${surgery.status}).`);

    const ot = await tx.operatingTheatre.findUnique({ where: { id: input.operatingTheatreId } });
    if (!ot || ot.facilityId !== input.facilityId) throw new NotFoundError("Operating theatre not found.");
    if (!ot.active) throw new BadRequestError("Operating theatre is inactive.");

    const existingForSurgery = await tx.surgerySchedule.findUnique({ where: { surgeryId: input.surgeryId } });
    if (existingForSurgery && existingForSurgery.status === "SCHEDULED") throw new BadRequestError("This surgery is already scheduled.");

    // App-level overlap check (clean error). The Postgres EXCLUDE constraint
    // surgery_schedule_no_overlap is the actual race guarantee.
    const overlap = await tx.surgerySchedule.count({
      where: { operatingTheatreId: input.operatingTheatreId, status: "SCHEDULED", startAt: { lt: input.endAt }, endAt: { gt: input.startAt } },
    });
    if (overlap > 0) throw new SurgeryScheduleConflictError();

    let schedule;
    try {
      if (existingForSurgery) {
        schedule = await tx.surgerySchedule.update({ where: { surgeryId: input.surgeryId }, data: { operatingTheatreId: input.operatingTheatreId, facilityId: input.facilityId, startAt: input.startAt, endAt: input.endAt, status: "SCHEDULED", schedulerStaffId: input.schedulerStaffId, notes: input.notes } });
      } else {
        schedule = await tx.surgerySchedule.create({ data: { surgeryId: input.surgeryId, operatingTheatreId: input.operatingTheatreId, facilityId: input.facilityId, startAt: input.startAt, endAt: input.endAt, schedulerStaffId: input.schedulerStaffId, notes: input.notes } });
      }
    } catch {
      // Exclusion-constraint violation from a concurrent booking that passed
      // its own count check before either committed.
      throw new SurgeryScheduleConflictError();
    }

    if (surgery.status === "APPROVED") {
      await tx.surgery.updateMany({ where: { id: input.surgeryId, status: "APPROVED" }, data: { status: "SCHEDULED" } });
    }

    await tx.auditEvent.create({ data: { type: "hospital.ot.surgeryScheduled", userId: input.byUserId, detail: { surgeryId: input.surgeryId, operatingTheatreId: input.operatingTheatreId, startAt: input.startAt.toISOString(), endAt: input.endAt.toISOString() }, facilityId: surgery.facilityId, patientId: surgery.patientId, encounterId: surgery.encounterId } });
    return schedule;
  });
}

export async function cancelSchedule(input: { surgeryId: string; facilityId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const schedule = await tx.surgerySchedule.findUnique({ where: { surgeryId: input.surgeryId }, include: { surgery: true } });
    if (!schedule || schedule.facilityId !== input.facilityId) throw new NotFoundError("Schedule not found.");
    const result = await tx.surgerySchedule.updateMany({ where: { surgeryId: input.surgeryId, status: "SCHEDULED" }, data: { status: "CANCELLED" } });
    if (result.count !== 1) throw new BadRequestError("Schedule is not active.");
    await tx.auditEvent.create({ data: { type: "hospital.ot.surgeryScheduleCancelled", userId: input.byUserId, detail: { surgeryId: input.surgeryId }, facilityId: input.facilityId, patientId: schedule.surgery.patientId, encounterId: schedule.surgery.encounterId } });
    return tx.surgerySchedule.findUniqueOrThrow({ where: { surgeryId: input.surgeryId } });
  });
}

// ── Team ──────────────────────────────────────────────────────────────────
export async function setTeamMember(input: { surgeryId: string; facilityId: string; staffId: string; role: string; byUserId: string }) {
  const surgery = await prisma.surgery.findUnique({ where: { id: input.surgeryId } });
  if (!surgery || surgery.facilityId !== input.facilityId) throw new NotFoundError("Surgery not found.");
  const staff = await prisma.hospitalStaffProfile.findUnique({ where: { id: input.staffId } });
  if (!staff || staff.facilityId !== input.facilityId) throw new NotFoundError("Staff member not found in this facility.");
  return prisma.surgeryTeamMember.upsert({
    where: { surgeryId_staffId_role: { surgeryId: input.surgeryId, staffId: input.staffId, role: input.role } },
    create: { surgeryId: input.surgeryId, staffId: input.staffId, role: input.role },
    update: {},
  });
}

// ── Checklist (WHO-style) ───────────────────────────────────────────────────
const CHECKLIST_TEMPLATE: { phase: string; itemKey: string; label: string }[] = [
  { phase: "BEFORE_INDUCTION", itemKey: "identity", label: "Patient identity confirmed" },
  { phase: "BEFORE_INDUCTION", itemKey: "procedure", label: "Procedure confirmed" },
  { phase: "BEFORE_INDUCTION", itemKey: "site", label: "Site/laterality confirmed" },
  { phase: "BEFORE_INDUCTION", itemKey: "consent", label: "Consent confirmed" },
  { phase: "BEFORE_INDUCTION", itemKey: "allergies", label: "Allergies reviewed" },
  { phase: "BEFORE_INDUCTION", itemKey: "anesthesia", label: "Anesthesia safety check" },
  { phase: "BEFORE_INCISION", itemKey: "team", label: "Team members introduced" },
  { phase: "BEFORE_INCISION", itemKey: "confirmProcedure", label: "Procedure/site verbally confirmed" },
  { phase: "BEFORE_INCISION", itemKey: "concerns", label: "Anticipated critical concerns documented" },
  { phase: "BEFORE_LEAVING", itemKey: "procedureRecorded", label: "Procedure recorded" },
  { phase: "BEFORE_LEAVING", itemKey: "counts", label: "Instrument/sponge counts completed" },
  { phase: "BEFORE_LEAVING", itemKey: "specimens", label: "Specimens labelled" },
  { phase: "BEFORE_LEAVING", itemKey: "equipment", label: "Equipment issues documented" },
  { phase: "BEFORE_LEAVING", itemKey: "recovery", label: "Recovery destination confirmed" },
];

export async function ensureChecklist(surgeryId: string, facilityId: string) {
  const surgery = await prisma.surgery.findUnique({ where: { id: surgeryId } });
  if (!surgery || surgery.facilityId !== facilityId) throw new NotFoundError("Surgery not found.");
  const existing = await prisma.surgeryChecklistItem.count({ where: { surgeryId } });
  if (existing === 0) {
    await prisma.surgeryChecklistItem.createMany({ data: CHECKLIST_TEMPLATE.map((t) => ({ surgeryId, phase: t.phase, itemKey: t.itemKey, label: t.label })) });
  }
  return prisma.surgeryChecklistItem.findMany({ where: { surgeryId }, orderBy: [{ phase: "asc" }, { itemKey: "asc" }] });
}

export async function updateChecklistItem(input: { surgeryId: string; facilityId: string; itemKey: string; checked: boolean; checkedByStaffId: string; byUserId: string }) {
  const surgery = await prisma.surgery.findUnique({ where: { id: input.surgeryId } });
  if (!surgery || surgery.facilityId !== input.facilityId) throw new NotFoundError("Surgery not found.");
  const item = await prisma.surgeryChecklistItem.findUnique({ where: { surgeryId_itemKey: { surgeryId: input.surgeryId, itemKey: input.itemKey } } });
  if (!item) throw new NotFoundError("Checklist item not found.");
  const updated = await prisma.surgeryChecklistItem.update({
    where: { surgeryId_itemKey: { surgeryId: input.surgeryId, itemKey: input.itemKey } },
    data: { checked: input.checked, checkedByStaffId: input.checked ? input.checkedByStaffId : null, checkedAt: input.checked ? new Date() : null },
  });
  await recordAuditEvent("hospital.ot.checklistUpdated", input.byUserId, { surgeryId: input.surgeryId, itemKey: input.itemKey, checked: input.checked }, { facilityId: surgery.facilityId, patientId: surgery.patientId, encounterId: surgery.encounterId });
  return updated;
}

// ── Anesthesia ──────────────────────────────────────────────────────────────
export async function recordAnesthesia(input: { surgeryId: string; facilityId: string; type: AnesthesiaType; anesthetistStaffId: string; status?: string; startAt?: Date; endAt?: Date; intraOpNotes?: string; complications?: string; byUserId: string }) {
  const surgery = await prisma.surgery.findUnique({ where: { id: input.surgeryId } });
  if (!surgery || surgery.facilityId !== input.facilityId) throw new NotFoundError("Surgery not found.");
  const rec = await prisma.anesthesiaRecord.upsert({
    where: { surgeryId: input.surgeryId },
    create: { surgeryId: input.surgeryId, type: input.type, anesthetistStaffId: input.anesthetistStaffId, status: input.status ?? "PLANNED", startAt: input.startAt, endAt: input.endAt, intraOpNotes: input.intraOpNotes, complications: input.complications },
    update: { type: input.type, anesthetistStaffId: input.anesthetistStaffId, ...(input.status ? { status: input.status } : {}), ...(input.startAt ? { startAt: input.startAt } : {}), ...(input.endAt ? { endAt: input.endAt } : {}), ...(input.intraOpNotes !== undefined ? { intraOpNotes: input.intraOpNotes } : {}), ...(input.complications !== undefined ? { complications: input.complications } : {}) },
  });
  await recordAuditEvent("hospital.ot.anesthesiaRecorded", input.byUserId, { surgeryId: input.surgeryId, type: input.type, status: rec.status }, { facilityId: surgery.facilityId, patientId: surgery.patientId, encounterId: surgery.encounterId });
  return rec;
}

// ── Procedure execution ─────────────────────────────────────────────────────
export async function startProcedure(input: { surgeryId: string; facilityId: string; surgeonStaffId?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const surgery = await tx.surgery.findUnique({ where: { id: input.surgeryId } });
    if (!surgery || surgery.facilityId !== input.facilityId) throw new NotFoundError("Surgery not found.");
    if (surgery.status !== "SCHEDULED") throw new SurgeryTransitionError(surgery.status, "IN_PROGRESS");
    const result = await tx.surgery.updateMany({ where: { id: input.surgeryId, status: "SCHEDULED" }, data: { status: "IN_PROGRESS", actualStart: new Date(), surgeonStaffId: input.surgeonStaffId ?? surgery.surgeonStaffId } });
    if (result.count !== 1) throw new SurgeryTransitionError(surgery.status, "IN_PROGRESS");
    await tx.auditEvent.create({ data: { type: "hospital.ot.procedureStarted", userId: input.byUserId, detail: { surgeryId: input.surgeryId }, facilityId: surgery.facilityId, patientId: surgery.patientId, encounterId: surgery.encounterId } });
    return tx.surgery.findUniqueOrThrow({ where: { id: input.surgeryId } });
  });
}

export async function completeProcedure(input: { surgeryId: string; facilityId: string; operativeFindings?: string; operativeDetails?: string; complications?: string; estimatedBloodLossMl?: number; recoveryDestination?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const surgery = await tx.surgery.findUnique({ where: { id: input.surgeryId } });
    if (!surgery || surgery.facilityId !== input.facilityId) throw new NotFoundError("Surgery not found.");
    if (surgery.status !== "IN_PROGRESS") throw new SurgeryTransitionError(surgery.status, "COMPLETED");
    const result = await tx.surgery.updateMany({
      where: { id: input.surgeryId, status: "IN_PROGRESS" },
      data: { status: "COMPLETED", actualEnd: new Date(), operativeFindings: input.operativeFindings, operativeDetails: input.operativeDetails, complications: input.complications, estimatedBloodLossMl: input.estimatedBloodLossMl, recoveryDestination: input.recoveryDestination },
    });
    if (result.count !== 1) throw new SurgeryTransitionError(surgery.status, "COMPLETED");

    // Seed a recovery record if a destination was given (workflow status only).
    if (input.recoveryDestination) {
      await tx.recoveryRecord.upsert({ where: { surgeryId: input.surgeryId }, create: { surgeryId: input.surgeryId, destination: input.recoveryDestination, status: "PENDING" }, update: { destination: input.recoveryDestination } });
    }
    await tx.auditEvent.create({ data: { type: "hospital.ot.procedureCompleted", userId: input.byUserId, detail: { surgeryId: input.surgeryId }, facilityId: surgery.facilityId, patientId: surgery.patientId, encounterId: surgery.encounterId } });
    return tx.surgery.findUniqueOrThrow({ where: { id: input.surgeryId } });
  });
}

// ── Specimens (patient/encounter/facility derived from the surgery) ─────────
export async function collectSpecimen(input: { surgeryId: string; facilityId: string; specimenType: string; site?: string; label?: string; destinationLab?: string; collectedByStaffId: string; notes?: string; byUserId: string }) {
  const surgery = await prisma.surgery.findUnique({ where: { id: input.surgeryId } });
  if (!surgery || surgery.facilityId !== input.facilityId) throw new NotFoundError("Surgery not found.");
  const specimen = await prisma.surgicalSpecimen.create({
    data: { surgeryId: surgery.id, facilityId: surgery.facilityId, patientId: surgery.patientId, encounterId: surgery.encounterId, specimenType: input.specimenType, site: input.site, label: input.label, destinationLab: input.destinationLab, collectedByStaffId: input.collectedByStaffId, notes: input.notes },
  });
  await recordAuditEvent("hospital.ot.specimenCollected", input.byUserId, { surgeryId: surgery.id, specimenId: specimen.id, specimenType: input.specimenType }, { facilityId: surgery.facilityId, patientId: surgery.patientId, encounterId: surgery.encounterId });
  return specimen;
}

// ── Implants / consumables (canonical inventory) ────────────────────────────
export async function recordItemUsage(input: {
  surgeryId: string; facilityId: string; usageType: "IMPLANT" | "CONSUMABLE"; itemId: string; itemLotId?: string;
  quantity: number; manufacturer?: string; serialNumber?: string; site?: string; locationId?: string; recordedByStaffId: string; actorUserId: string; byUserId: string;
}) {
  if (input.quantity <= 0) throw new BadRequestError("Quantity must be positive.");
  const surgery = await prisma.surgery.findUnique({ where: { id: input.surgeryId } });
  if (!surgery || surgery.facilityId !== input.facilityId) throw new NotFoundError("Surgery not found.");

  const usage = await prisma.$transaction(async (tx) => {
    const created = await tx.surgeryItemUsage.create({
      data: {
        surgeryId: surgery.id, facilityId: surgery.facilityId, patientId: surgery.patientId, encounterId: surgery.encounterId,
        usageType: input.usageType, itemId: input.itemId, itemLotId: input.itemLotId, quantity: input.quantity,
        manufacturer: input.manufacturer, serialNumber: input.serialNumber, site: input.site,
        implantedAt: input.usageType === "IMPLANT" ? new Date() : null, recordedByStaffId: input.recordedByStaffId,
      },
    });

    // Transactional stock consumption when an issuing location is given.
    // issueStock validates item/lot/facility, FEFO, expiry/quarantine, and
    // never over-issues (guarded UPDATE). If it throws, the whole usage row
    // rolls back — never a falsely-recorded consumption.
    if (input.locationId) {
      await issueStock(tx, {
        facilityId: surgery.facilityId, itemId: input.itemId, locationId: input.locationId, quantity: input.quantity, lotId: input.itemLotId,
        requestedByStaffId: input.recordedByStaffId, actorUserId: input.actorUserId, reason: `Surgery ${input.usageType.toLowerCase()}`,
        patientId: surgery.patientId, encounterId: surgery.encounterId, sourceType: "SurgeryItemUsage", sourceId: created.id,
      });
      await tx.surgeryItemUsage.update({ where: { id: created.id }, data: { stockConsumed: true } });
    }

    await tx.auditEvent.create({
      data: { type: input.usageType === "IMPLANT" ? "hospital.ot.implantRecorded" : "hospital.ot.consumableRecorded", userId: input.byUserId, detail: { surgeryId: surgery.id, usageId: created.id, itemId: input.itemId, quantity: input.quantity, stockConsumed: Boolean(input.locationId) }, facilityId: surgery.facilityId, patientId: surgery.patientId, encounterId: surgery.encounterId },
    });
    return tx.surgeryItemUsage.findUniqueOrThrow({ where: { id: created.id } });
  });
  return usage;
}

// ── Recovery (PACU) ──────────────────────────────────────────────────────────
const RECOVERY_TRANSITIONS: Record<string, string[]> = {
  PENDING: ["IN_RECOVERY", "TRANSFERRED"],
  IN_RECOVERY: ["READY_FOR_TRANSFER", "TRANSFERRED"],
  READY_FOR_TRANSFER: ["TRANSFERRED"],
  TRANSFERRED: [],
};

export async function updateRecovery(input: { surgeryId: string; facilityId: string; status?: string; destination?: string; responsibleStaffId?: string; nurseStaffId?: string; notes?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const surgery = await tx.surgery.findUnique({ where: { id: input.surgeryId } });
    if (!surgery || surgery.facilityId !== input.facilityId) throw new NotFoundError("Surgery not found.");
    const existing = await tx.recoveryRecord.findUnique({ where: { surgeryId: input.surgeryId } });

    if (input.status && existing) {
      if (existing.status === input.status) { /* idempotent no-op allowed */ }
      else if (!(RECOVERY_TRANSITIONS[existing.status] ?? []).includes(input.status)) {
        throw new BadRequestError(`Illegal recovery transition ${existing.status} -> ${input.status}.`);
      }
      const result = await tx.recoveryRecord.updateMany({
        where: { surgeryId: input.surgeryId, status: existing.status },
        data: {
          ...(input.status ? { status: input.status } : {}),
          ...(input.destination !== undefined ? { destination: input.destination } : {}),
          ...(input.responsibleStaffId !== undefined ? { responsibleStaffId: input.responsibleStaffId } : {}),
          ...(input.nurseStaffId !== undefined ? { nurseStaffId: input.nurseStaffId } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.status === "IN_RECOVERY" && !existing.arrivalAt ? { arrivalAt: new Date() } : {}),
          ...(input.status === "TRANSFERRED" ? { departureAt: new Date() } : {}),
        },
      });
      if (result.count !== 1) throw new BadRequestError("Recovery state changed concurrently — refresh and try again.");
    } else if (!existing) {
      await tx.recoveryRecord.create({ data: { surgeryId: input.surgeryId, status: input.status ?? "PENDING", destination: input.destination, responsibleStaffId: input.responsibleStaffId, nurseStaffId: input.nurseStaffId, notes: input.notes, arrivalAt: input.status === "IN_RECOVERY" ? new Date() : undefined } });
    }

    await tx.auditEvent.create({ data: { type: "hospital.ot.recoveryUpdated", userId: input.byUserId, detail: { surgeryId: input.surgeryId, status: input.status }, facilityId: surgery.facilityId, patientId: surgery.patientId, encounterId: surgery.encounterId } });
    return tx.recoveryRecord.findUniqueOrThrow({ where: { surgeryId: input.surgeryId } });
  });
}

// ── Composition: workspace, board, timeline ─────────────────────────────────
export async function getSurgeryWorkspace(surgeryId: string) {
  const surgery = await prisma.surgery.findUniqueOrThrow({
    where: { id: surgeryId },
    include: {
      patient: true, procedure: true, schedule: { include: { operatingTheatre: true } },
      team: true, checklist: { orderBy: [{ phase: "asc" }, { itemKey: "asc" }] }, anesthesia: true,
      specimens: { orderBy: { collectedAt: "desc" } }, itemUsages: { orderBy: { createdAt: "desc" } }, recovery: true,
    },
  });
  const [notes, location, labs, imaging] = await Promise.all([
    prisma.clinicalNote.findMany({ where: { encounterId: surgery.encounterId, type: { in: ["OPERATIVE", "ANESTHESIA", "RECOVERY", "ICU_PROGRESS", "PROGRESS"] } }, include: { author: { include: { user: true } } }, orderBy: { createdAt: "desc" }, take: 8 }),
    prisma.encounterLocation.findFirst({ where: { encounterId: surgery.encounterId, releasedAt: null }, include: { bed: { include: { ward: true } } }, orderBy: { assignedAt: "desc" } }),
    prisma.labOrder.findMany({ where: { encounterId: surgery.encounterId }, include: { results: { where: { isCurrent: true } } }, orderBy: { orderedAt: "desc" }, take: 8 }),
    prisma.imagingOrder.findMany({ where: { encounterId: surgery.encounterId }, include: { reports: { where: { isCurrent: true } } }, orderBy: { orderedAt: "desc" }, take: 8 }),
  ]);
  return { surgery, notes, location, labs, imaging };
}

export async function buildOtBoard(facilityId: string) {
  const schedules = await prisma.surgerySchedule.findMany({
    where: { facilityId, status: "SCHEDULED" },
    include: { operatingTheatre: true, surgery: { include: { patient: true, recovery: true, checklist: true } } },
    orderBy: { startAt: "asc" },
  });
  return schedules.map((s) => {
    const checkedCount = s.surgery.checklist.filter((c) => c.checked).length;
    return {
      scheduleId: s.id, surgeryId: s.surgeryId, ot: s.operatingTheatre.name, startAt: s.startAt, endAt: s.endAt,
      procedureName: s.surgery.procedureName, status: s.surgery.status, laterality: s.surgery.laterality, urgency: s.surgery.urgency,
      surgeonStaffId: s.surgery.surgeonStaffId,
      patient: { id: s.surgery.patient.id, fullName: s.surgery.patient.fullName, uhid: s.surgery.patient.uhid },
      checklistProgress: `${checkedCount}/${s.surgery.checklist.length}`,
      recoveryStatus: s.surgery.recovery?.status ?? null,
    };
  });
}

export interface SurgeryTimelineEntry { id: string; timestamp: string; type: string; summary: string; sourceType: string; sourceId: string }

export async function buildSurgeryTimeline(surgeryId: string): Promise<SurgeryTimelineEntry[]> {
  const surgery = await prisma.surgery.findUniqueOrThrow({
    where: { id: surgeryId },
    include: { schedule: { include: { operatingTheatre: true } }, anesthesia: true, specimens: true, itemUsages: true, recovery: true, checklist: true },
  });
  const e: SurgeryTimelineEntry[] = [];
  e.push({ id: `req-${surgery.id}`, timestamp: surgery.createdAt.toISOString(), type: "Requested", summary: `Surgery requested: ${surgery.procedureName}`, sourceType: "Surgery", sourceId: surgery.id });
  if (surgery.reviewedAt) e.push({ id: `rev-${surgery.id}`, timestamp: surgery.reviewedAt.toISOString(), type: "Reviewed", summary: "Reviewed", sourceType: "Surgery", sourceId: surgery.id });
  if (surgery.approvedAt) e.push({ id: `app-${surgery.id}`, timestamp: surgery.approvedAt.toISOString(), type: "Approved", summary: "Approved", sourceType: "Surgery", sourceId: surgery.id });
  if (surgery.schedule && surgery.schedule.status === "SCHEDULED") e.push({ id: `sch-${surgery.schedule.id}`, timestamp: surgery.schedule.startAt.toISOString(), type: "Scheduled", summary: `Scheduled in ${surgery.schedule.operatingTheatre.name}`, sourceType: "SurgerySchedule", sourceId: surgery.schedule.id });
  if (surgery.actualStart) e.push({ id: `start-${surgery.id}`, timestamp: surgery.actualStart.toISOString(), type: "ProcedureStart", summary: "Procedure started", sourceType: "Surgery", sourceId: surgery.id });
  if (surgery.anesthesia?.startAt) e.push({ id: `anes-${surgery.anesthesia.id}`, timestamp: surgery.anesthesia.startAt.toISOString(), type: "Anesthesia", summary: `${surgery.anesthesia.type} anesthesia`, sourceType: "AnesthesiaRecord", sourceId: surgery.anesthesia.id });
  for (const s of surgery.specimens) e.push({ id: `spec-${s.id}`, timestamp: s.collectedAt.toISOString(), type: "Specimen", summary: `Specimen: ${s.specimenType}${s.site ? ` (${s.site})` : ""}`, sourceType: "SurgicalSpecimen", sourceId: s.id });
  for (const u of surgery.itemUsages) e.push({ id: `use-${u.id}`, timestamp: (u.implantedAt ?? u.createdAt).toISOString(), type: u.usageType === "IMPLANT" ? "Implant" : "Consumable", summary: `${u.usageType}: item ${u.itemId} x${u.quantity}`, sourceType: "SurgeryItemUsage", sourceId: u.id });
  if (surgery.actualEnd) e.push({ id: `end-${surgery.id}`, timestamp: surgery.actualEnd.toISOString(), type: "ProcedureEnd", summary: "Procedure completed", sourceType: "Surgery", sourceId: surgery.id });
  if (surgery.recovery?.arrivalAt) e.push({ id: `pacu-${surgery.recovery.id}`, timestamp: surgery.recovery.arrivalAt.toISOString(), type: "Recovery", summary: `Recovery (${surgery.recovery.destination ?? "PACU"})`, sourceType: "RecoveryRecord", sourceId: surgery.recovery.id });
  if (surgery.recovery?.departureAt) e.push({ id: `pacu-out-${surgery.recovery.id}`, timestamp: surgery.recovery.departureAt.toISOString(), type: "RecoveryTransfer", summary: "Transferred out of recovery", sourceType: "RecoveryRecord", sourceId: surgery.recovery.id });
  if (surgery.cancelledAt) e.push({ id: `cancel-${surgery.id}`, timestamp: surgery.cancelledAt.toISOString(), type: "Cancelled", summary: `Cancelled: ${surgery.cancelledReason ?? ""}`, sourceType: "Surgery", sourceId: surgery.id });
  return e.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
