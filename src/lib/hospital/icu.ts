import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { admitPatient, transferPatient } from "./admission";

/**
 * ICU Foundation service (Phase B1). Builds on the existing ADT
 * (admitPatient/transferPatient), Vital, IntakeOutputRecord, MAR, Task,
 * ClinicalNote and ClinicalHandoff machinery — never a parallel patient/
 * encounter/bed/medication system. All observation recording is documentary
 * (values as entered); no clinical scoring, interpretation, dosing, or
 * decision support is computed here. Bed/ventilator/isolation matching is
 * pure resource matching (explicit requirement vs explicit capability), not
 * a clinical judgement.
 */

const OBSERVATION_TYPES = ["VENTILATOR", "NEURO", "ABG"];
const DEVICE_STATUSES = ["PLANNED", "ACTIVE", "REMOVED", "DISCONTINUED"];
const INFUSION_STATUSES = ["RUNNING", "PAUSED", "STOPPED"];

export class IcuBedCapabilityError extends BadRequestError {
  constructor(message: string) {
    super(message);
  }
}

// ── ICU unit configuration ──────────────────────────────────────────────

export async function createIcuUnit(input: {
  facilityId: string;
  name: string;
  icuType?: "MICU" | "SICU" | "CCU" | "NICU" | "PICU" | "HDU" | "GENERAL_ICU";
  departmentId?: string;
  ventilatorCapable?: boolean;
  isolationCapable?: boolean;
  bedCapacity?: number;
  notes?: string;
  byUserId: string;
}) {
  const unit = await prisma.icuUnit.create({
    data: {
      facilityId: input.facilityId,
      name: input.name,
      icuType: input.icuType ?? "GENERAL_ICU",
      departmentId: input.departmentId,
      ventilatorCapable: input.ventilatorCapable ?? false,
      isolationCapable: input.isolationCapable ?? false,
      bedCapacity: input.bedCapacity,
      notes: input.notes,
    },
  });
  await recordAuditEvent("hospital.icu.unitConfigured", input.byUserId, { icuUnitId: unit.id, name: unit.name, icuType: unit.icuType }, { facilityId: input.facilityId });
  return unit;
}

// ── ICU admission / transfer (capability-matched, delegates to ADT) ───────

async function assertBedIcuCompatible(
  bedId: string,
  facilityId: string,
  requirements: { requireVentilator?: boolean; requireIsolation?: boolean }
) {
  const bed = await prisma.bed.findUnique({ where: { id: bedId } });
  if (!bed || bed.facilityId !== facilityId) throw new NotFoundError("Bed not found.");
  if (!bed.icuCapable) throw new IcuBedCapabilityError("Selected bed is not ICU-capable.");
  if (requirements.requireVentilator && !bed.ventilatorCapable) {
    throw new IcuBedCapabilityError("Selected bed is not ventilator-capable, but a ventilator-capable bed was required.");
  }
  if (requirements.requireIsolation && !(bed.negativePressure || bed.isolationRequired)) {
    throw new IcuBedCapabilityError("Selected bed does not provide isolation, but an isolation-capable bed was required.");
  }
  return bed;
}

/** ICU admission — validates ICU bed capability, then reuses the existing guarded admitPatient. */
export async function admitToIcu(input: {
  encounterId: string;
  bedId: string;
  facilityId: string;
  admittingStaffId: string;
  reason: string;
  requireVentilator?: boolean;
  requireIsolation?: boolean;
  byUserId: string;
}) {
  const encounter = await prisma.encounter.findUnique({ where: { id: input.encounterId } });
  if (!encounter || encounter.facilityId !== input.facilityId) throw new NotFoundError("Encounter not found.");
  await assertBedIcuCompatible(input.bedId, input.facilityId, input);

  const admission = await admitPatient({
    encounterId: input.encounterId,
    bedId: input.bedId,
    admittingStaffId: input.admittingStaffId,
    reason: input.reason,
    admissionType: "EMERGENCY",
    byUserId: input.byUserId,
  });
  await recordAuditEvent(
    "hospital.icu.admitted",
    input.byUserId,
    { admissionId: admission.id, encounterId: input.encounterId, bedId: input.bedId },
    { facilityId: input.facilityId, patientId: encounter.patientId, encounterId: input.encounterId }
  );
  return admission;
}

/** ICU transfer — validates destination ICU bed capability, then reuses the existing guarded transferPatient. */
export async function transferWithinIcu(input: {
  admissionId: string;
  toBedId: string;
  facilityId: string;
  reason: string;
  requireVentilator?: boolean;
  requireIsolation?: boolean;
  byUserId: string;
}) {
  const admission = await prisma.admission.findUnique({ where: { id: input.admissionId }, include: { encounter: true } });
  if (!admission || admission.encounter.facilityId !== input.facilityId) throw new NotFoundError("Admission not found.");
  await assertBedIcuCompatible(input.toBedId, input.facilityId, input);

  const transfer = await transferPatient({ admissionId: input.admissionId, toBedId: input.toBedId, reason: input.reason, byUserId: input.byUserId });
  await recordAuditEvent(
    "hospital.icu.transferred",
    input.byUserId,
    { admissionId: input.admissionId, toBedId: input.toBedId },
    { facilityId: input.facilityId, patientId: admission.encounter.patientId, encounterId: admission.encounterId }
  );
  return transfer;
}

// ── Flowsheet observations (documentary — no interpretation) ──────────────

export async function recordObservation(input: {
  encounterId: string;
  facilityId: string;
  type: string;
  values: unknown;
  recordedByStaffId: string;
  byUserId: string;
}) {
  if (!OBSERVATION_TYPES.includes(input.type)) throw new BadRequestError(`type must be one of ${OBSERVATION_TYPES.join(", ")}.`);
  const encounter = await prisma.encounter.findUnique({ where: { id: input.encounterId } });
  if (!encounter || encounter.facilityId !== input.facilityId) throw new NotFoundError("Encounter not found.");

  const observation = await prisma.icuObservation.create({
    data: {
      encounterId: input.encounterId,
      facilityId: input.facilityId,
      patientId: encounter.patientId,
      type: input.type,
      values: input.values as object,
      recordedByStaffId: input.recordedByStaffId,
    },
  });
  await recordAuditEvent(
    "hospital.icu.observationRecorded",
    input.byUserId,
    { observationId: observation.id, type: input.type },
    { facilityId: input.facilityId, patientId: encounter.patientId, encounterId: input.encounterId }
  );
  return observation;
}

// ── Devices (lifecycle) ───────────────────────────────────────────────────

export async function recordDevice(input: {
  encounterId: string;
  facilityId: string;
  deviceType: string;
  site?: string;
  status?: string;
  insertedAt?: Date;
  notes?: string;
  recordedByStaffId: string;
  byUserId: string;
}) {
  const status = input.status ?? "PLANNED";
  if (!DEVICE_STATUSES.includes(status)) throw new BadRequestError(`status must be one of ${DEVICE_STATUSES.join(", ")}.`);
  const encounter = await prisma.encounter.findUnique({ where: { id: input.encounterId } });
  if (!encounter || encounter.facilityId !== input.facilityId) throw new NotFoundError("Encounter not found.");

  const device = await prisma.icuDevice.create({
    data: {
      encounterId: input.encounterId,
      facilityId: input.facilityId,
      patientId: encounter.patientId,
      deviceType: input.deviceType,
      site: input.site,
      status,
      insertedAt: status === "ACTIVE" ? input.insertedAt ?? new Date() : input.insertedAt,
      notes: input.notes,
      recordedByStaffId: input.recordedByStaffId,
    },
  });
  await recordAuditEvent(
    "hospital.icu.deviceRecorded",
    input.byUserId,
    { deviceId: device.id, deviceType: device.deviceType, status },
    { facilityId: input.facilityId, patientId: encounter.patientId, encounterId: input.encounterId }
  );
  return device;
}

export class DeviceStatusError extends BadRequestError {
  constructor(message: string) {
    super(message);
  }
}

/** Guarded device status transition — concurrent updates can't both win. */
export async function updateDeviceStatus(input: {
  deviceId: string;
  facilityId: string;
  status: string;
  removedAt?: Date;
  notes?: string;
  byUserId: string;
}) {
  if (!DEVICE_STATUSES.includes(input.status)) throw new BadRequestError(`status must be one of ${DEVICE_STATUSES.join(", ")}.`);
  return prisma.$transaction(async (tx) => {
    const device = await tx.icuDevice.findUnique({ where: { id: input.deviceId } });
    if (!device || device.facilityId !== input.facilityId) throw new NotFoundError("Device not found.");
    if (device.status === "REMOVED" || device.status === "DISCONTINUED") {
      throw new DeviceStatusError(`Device is already ${device.status.toLowerCase()} and cannot change state.`);
    }

    const isTerminal = input.status === "REMOVED" || input.status === "DISCONTINUED";
    const result = await tx.icuDevice.updateMany({
      where: { id: input.deviceId, status: { notIn: ["REMOVED", "DISCONTINUED"] } },
      data: {
        status: input.status,
        ...(input.status === "ACTIVE" && !device.insertedAt ? { insertedAt: new Date() } : {}),
        ...(isTerminal ? { removedAt: input.removedAt ?? new Date() } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
    });
    if (result.count !== 1) throw new DeviceStatusError("Device state changed concurrently — refresh and try again.");

    await tx.auditEvent.create({
      data: {
        type: "hospital.icu.deviceStatusChanged",
        userId: input.byUserId,
        detail: { deviceId: input.deviceId, status: input.status },
        facilityId: input.facilityId,
        patientId: device.patientId,
        encounterId: device.encounterId,
      },
    });
    return tx.icuDevice.findUniqueOrThrow({ where: { id: input.deviceId } });
  });
}

// ── Infusions (tracking; references the canonical MedicationOrder) ─────────

export async function recordInfusion(input: {
  encounterId: string;
  facilityId: string;
  drugName: string;
  medicationOrderId?: string;
  route?: string;
  concentration?: string;
  rate?: number;
  rateUnit?: string;
  prescriberStaffId?: string;
  recordedByStaffId: string;
  byUserId: string;
}) {
  const encounter = await prisma.encounter.findUnique({ where: { id: input.encounterId } });
  if (!encounter || encounter.facilityId !== input.facilityId) throw new NotFoundError("Encounter not found.");
  if (input.medicationOrderId) {
    const order = await prisma.medicationOrder.findUnique({ where: { id: input.medicationOrderId } });
    if (!order || order.encounterId !== input.encounterId) throw new NotFoundError("Medication order not found for this encounter.");
  }

  const infusion = await prisma.icuInfusion.create({
    data: {
      encounterId: input.encounterId,
      facilityId: input.facilityId,
      patientId: encounter.patientId,
      medicationOrderId: input.medicationOrderId,
      drugName: input.drugName,
      route: input.route,
      concentration: input.concentration,
      rate: input.rate,
      rateUnit: input.rateUnit,
      prescriberStaffId: input.prescriberStaffId,
      recordedByStaffId: input.recordedByStaffId,
    },
  });
  await recordAuditEvent(
    "hospital.icu.infusionRecorded",
    input.byUserId,
    { infusionId: infusion.id, drugName: infusion.drugName },
    { facilityId: input.facilityId, patientId: encounter.patientId, encounterId: input.encounterId }
  );
  return infusion;
}

export async function updateInfusionStatus(input: {
  infusionId: string;
  facilityId: string;
  status: string;
  rate?: number;
  byUserId: string;
}) {
  if (!INFUSION_STATUSES.includes(input.status)) throw new BadRequestError(`status must be one of ${INFUSION_STATUSES.join(", ")}.`);
  return prisma.$transaction(async (tx) => {
    const infusion = await tx.icuInfusion.findUnique({ where: { id: input.infusionId } });
    if (!infusion || infusion.facilityId !== input.facilityId) throw new NotFoundError("Infusion not found.");
    if (infusion.status === "STOPPED") throw new BadRequestError("Infusion is already stopped.");

    const result = await tx.icuInfusion.updateMany({
      where: { id: input.infusionId, status: { not: "STOPPED" } },
      data: {
        status: input.status,
        ...(input.rate !== undefined ? { rate: input.rate } : {}),
        ...(input.status === "STOPPED" ? { stoppedAt: new Date() } : {}),
      },
    });
    if (result.count !== 1) throw new BadRequestError("Infusion state changed concurrently — refresh and try again.");

    await tx.auditEvent.create({
      data: {
        type: "hospital.icu.infusionStatusChanged",
        userId: input.byUserId,
        detail: { infusionId: input.infusionId, status: input.status },
        facilityId: input.facilityId,
        patientId: infusion.patientId,
        encounterId: infusion.encounterId,
      },
    });
    return tx.icuInfusion.findUniqueOrThrow({ where: { id: input.infusionId } });
  });
}

// ── Rounding composition (read-only over canonical records) ───────────────

export async function buildIcuRounding(encounterId: string) {
  const encounter = await prisma.encounter.findUniqueOrThrow({
    where: { id: encounterId },
    include: { patient: true, attendingStaff: { include: { user: true } } },
  });
  const [location, admission, vitals, observations, infusions, devices, io, medications, administrations, tasks, notes, handoffs, problems, carePlans, currentAssessment, labs, imaging, transfers] = await Promise.all([
    prisma.encounterLocation.findFirst({ where: { encounterId, releasedAt: null }, include: { bed: { include: { ward: true, icuUnit: true } } }, orderBy: { assignedAt: "desc" } }),
    prisma.admission.findUnique({ where: { encounterId }, include: { bed: { include: { ward: true } } } }),
    prisma.vital.findMany({ where: { encounterId }, orderBy: { recordedAt: "desc" }, take: 24 }),
    prisma.icuObservation.findMany({ where: { encounterId }, orderBy: { recordedAt: "desc" }, take: 60 }),
    prisma.icuInfusion.findMany({ where: { encounterId }, orderBy: { startedAt: "desc" }, take: 40 }),
    prisma.icuDevice.findMany({ where: { encounterId }, orderBy: { createdAt: "desc" }, take: 40 }),
    prisma.intakeOutputRecord.findMany({ where: { encounterId }, orderBy: { recordedAt: "desc" }, take: 60 }),
    prisma.medicationOrder.findMany({ where: { encounterId, status: { in: ["ORDERED", "VERIFIED", "DISPENSED", "ACTIVE"] } }, orderBy: { orderedAt: "desc" } }),
    prisma.medicationAdministration.findMany({ where: { medicationOrder: { encounterId }, administeredAt: { not: null } }, include: { medicationOrder: true }, orderBy: { administeredAt: "desc" }, take: 15 }),
    prisma.task.findMany({ where: { encounterId, status: { notIn: ["COMPLETED", "CANCELLED"] } }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.clinicalNote.findMany({ where: { encounterId }, orderBy: { createdAt: "desc" }, take: 5, include: { author: { include: { user: true } } } }),
    prisma.clinicalHandoff.findMany({ where: { encounterId }, orderBy: { createdAt: "desc" }, take: 5, include: { fromStaff: { include: { user: true } }, toStaff: { include: { user: true } } } }),
    prisma.problem.findMany({ where: { patientId: encounter.patientId, status: "active" } }),
    prisma.carePlan.findMany({ where: { encounterId, status: "ACTIVE" }, include: { interventions: true }, orderBy: { createdAt: "desc" } }),
    prisma.nursingAssessment.findFirst({ where: { encounterId, isCurrent: true }, orderBy: { createdAt: "desc" } }),
    prisma.labOrder.findMany({ where: { encounterId }, include: { results: { where: { isCurrent: true } } }, orderBy: { orderedAt: "desc" }, take: 10 }),
    prisma.imagingOrder.findMany({ where: { encounterId }, include: { reports: { where: { isCurrent: true } } }, orderBy: { orderedAt: "desc" }, take: 10 }),
    prisma.transfer.findMany({ where: { admission: { encounterId } }, include: { fromBed: true, toBed: true }, orderBy: { transferredAt: "desc" } }),
  ]);

  // Transparent I/O totals over the returned window (§13) — never mixes
  // units (IntakeOutputRecord is uniformly mL) and shows the arithmetic.
  const totalInput = io.filter((r) => r.ioType === "INPUT").reduce((s, r) => s + r.quantityMl, 0);
  const totalOutput = io.filter((r) => r.ioType === "OUTPUT").reduce((s, r) => s + r.quantityMl, 0);
  const ioTotals = { totalInputMl: totalInput, totalOutputMl: totalOutput, netMl: totalInput - totalOutput, entryCount: io.length };

  // Length of stay derived from canonical timestamps (§29): ICU stay from
  // the current open ICU location; total encounter stay from registration.
  const now = Date.now();
  const icuStayMs = location ? now - new Date(location.assignedAt).getTime() : null;
  const encounterStayMs = now - new Date(encounter.registeredAt).getTime();
  const los = {
    icuStayHours: icuStayMs !== null ? Math.floor(icuStayMs / 3_600_000) : null,
    encounterStayHours: Math.floor(encounterStayMs / 3_600_000),
    admittedAt: admission?.admittedAt ?? null,
    icuSince: location?.assignedAt ?? null,
    registeredAt: encounter.registeredAt,
  };

  return { encounter, location, admission, los, vitals, observations, infusions, devices, io, ioTotals, medications, administrations, tasks, notes, handoffs, problems, carePlans, currentAssessment, labs, imaging, transfers };
}

/**
 * ICU-scoped longitudinal timeline (§26) — pure composition over canonical
 * records for one encounter (ICU admission/transfers, vitals, ICU
 * observations, infusions, devices, I/O, labs, imaging, notes, tasks,
 * handoffs, nursing assessments, care-plan activity). No second event store.
 */
export interface IcuTimelineEntry {
  id: string;
  timestamp: string;
  type: string;
  summary: string;
  actor?: string | null;
  sourceType: string;
  sourceId: string;
}

export async function buildIcuTimeline(encounterId: string): Promise<IcuTimelineEntry[]> {
  const [admission, transfers, vitals, observations, infusions, devices, io, notes, tasks, handoffs, assessments, labResults, imagingReports, carePlans] = await Promise.all([
    prisma.admission.findUnique({ where: { encounterId }, include: { bed: true } }),
    prisma.transfer.findMany({ where: { admission: { encounterId } }, include: { fromBed: true, toBed: true } }),
    prisma.vital.findMany({ where: { encounterId }, orderBy: { recordedAt: "desc" }, take: 100 }),
    prisma.icuObservation.findMany({ where: { encounterId }, orderBy: { recordedAt: "desc" }, take: 100 }),
    prisma.icuInfusion.findMany({ where: { encounterId }, orderBy: { startedAt: "desc" }, take: 100 }),
    prisma.icuDevice.findMany({ where: { encounterId }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.intakeOutputRecord.findMany({ where: { encounterId }, orderBy: { recordedAt: "desc" }, take: 100 }),
    prisma.clinicalNote.findMany({ where: { encounterId }, include: { author: { include: { user: true } } }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.task.findMany({ where: { encounterId }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.clinicalHandoff.findMany({ where: { encounterId }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.nursingAssessment.findMany({ where: { encounterId }, orderBy: { createdAt: "desc" }, take: 50 }),
    prisma.labResult.findMany({ where: { labOrder: { encounterId } }, orderBy: { resultedAt: "desc" }, take: 50 }),
    prisma.imagingReport.findMany({ where: { imagingOrder: { encounterId } }, orderBy: { reportedAt: "desc" }, take: 50 }),
    prisma.carePlan.findMany({ where: { encounterId }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);

  const e: IcuTimelineEntry[] = [];
  if (admission) e.push({ id: `adm-${admission.id}`, timestamp: admission.admittedAt.toISOString(), type: "Admission", summary: `Admitted — bed ${admission.bed.label}${admission.admissionType ? ` (${admission.admissionType})` : ""}`, sourceType: "Admission", sourceId: admission.id });
  for (const t of transfers) e.push({ id: `xfer-${t.id}`, timestamp: t.transferredAt.toISOString(), type: "Transfer", summary: `Transfer ${t.fromBed.label} → ${t.toBed.label}`, sourceType: "Transfer", sourceId: t.id });
  for (const v of vitals) e.push({ id: `vit-${v.id}`, timestamp: v.recordedAt.toISOString(), type: "Vital", summary: `HR ${v.hr ?? "-"} · BP ${v.sbp ?? "-"}/${v.dbp ?? "-"} · SpO2 ${v.spo2 ?? "-"}%`, sourceType: "Vital", sourceId: v.id });
  for (const o of observations) e.push({ id: `obs-${o.id}`, timestamp: o.recordedAt.toISOString(), type: `Observation:${o.type}`, summary: Object.entries(o.values as Record<string, unknown>).map(([k, val]) => `${k}:${val}`).join(" "), sourceType: "IcuObservation", sourceId: o.id });
  for (const inf of infusions) e.push({ id: `inf-${inf.id}`, timestamp: inf.startedAt.toISOString(), type: "Infusion", summary: `${inf.drugName} ${inf.rate ?? "-"} ${inf.rateUnit ?? ""} (${inf.status})`, sourceType: "IcuInfusion", sourceId: inf.id });
  for (const d of devices) e.push({ id: `dev-${d.id}`, timestamp: (d.insertedAt ?? d.createdAt).toISOString(), type: "Device", summary: `${d.deviceType}${d.site ? ` (${d.site})` : ""} — ${d.status}`, sourceType: "IcuDevice", sourceId: d.id });
  for (const r of io) e.push({ id: `io-${r.id}`, timestamp: r.recordedAt.toISOString(), type: "I/O", summary: `${r.ioType} · ${r.category} · ${r.quantityMl}mL`, sourceType: "IntakeOutputRecord", sourceId: r.id });
  for (const n of notes) e.push({ id: `note-${n.id}`, timestamp: n.createdAt.toISOString(), type: "Note", summary: `${n.type} note ${n.status.toLowerCase()}`, actor: n.author?.user?.displayName, sourceType: "ClinicalNote", sourceId: n.id });
  for (const t of tasks) e.push({ id: `task-${t.id}`, timestamp: t.createdAt.toISOString(), type: "Task", summary: `${t.title} (${t.status})`, sourceType: "Task", sourceId: t.id });
  for (const h of handoffs) e.push({ id: `ho-${h.id}`, timestamp: h.createdAt.toISOString(), type: "Handoff", summary: `Handoff ${h.status.toLowerCase()} — ${h.summary}`, sourceType: "ClinicalHandoff", sourceId: h.id });
  for (const a of assessments) e.push({ id: `na-${a.id}`, timestamp: a.createdAt.toISOString(), type: "NursingAssessment", summary: `Nursing assessment v${a.version} (${a.status})`, sourceType: "NursingAssessment", sourceId: a.id });
  for (const r of labResults) e.push({ id: `lab-${r.id}`, timestamp: r.resultedAt.toISOString(), type: "LabResult", summary: `Lab result${r.isCritical ? " — CRITICAL" : ""}: ${r.value} ${r.unit ?? ""}`, sourceType: "LabResult", sourceId: r.id });
  for (const r of imagingReports) e.push({ id: `img-${r.id}`, timestamp: r.reportedAt.toISOString(), type: "ImagingReport", summary: `Imaging report${r.isCritical ? " — CRITICAL" : ""}: ${r.impression}`, sourceType: "ImagingReport", sourceId: r.id });
  for (const cp of carePlans) e.push({ id: `cp-${cp.id}`, timestamp: cp.createdAt.toISOString(), type: "CarePlan", summary: `Care plan: ${cp.problem} (${cp.status})`, sourceType: "CarePlan", sourceId: cp.id });

  return e.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** ICU patient board — occupied ICU-capable beds with a latest-vital summary. */
export async function buildIcuBoard(facilityId: string) {
  const beds = await prisma.bed.findMany({
    where: { facilityId, icuCapable: true },
    include: { ward: true, icuUnit: true },
    orderBy: { label: "asc" },
  });

  const board = await Promise.all(
    beds.map(async (bed) => {
      const location = await prisma.encounterLocation.findFirst({
        where: { bedId: bed.id, releasedAt: null },
        include: { encounter: { include: { patient: true, attendingStaff: { include: { user: true } } } } },
        orderBy: { assignedAt: "desc" },
      });
      let latestVital = null as Awaited<ReturnType<typeof prisma.vital.findFirst>> | null;
      let openTasks = 0;
      if (location?.encounterId) {
        latestVital = await prisma.vital.findFirst({ where: { encounterId: location.encounterId }, orderBy: { recordedAt: "desc" } });
        openTasks = await prisma.task.count({ where: { encounterId: location.encounterId, status: { notIn: ["COMPLETED", "CANCELLED"] } } });
      }
      return {
        bedId: bed.id,
        bedLabel: bed.label,
        icuUnit: bed.icuUnit?.name ?? bed.ward.name,
        status: bed.status,
        ventilatorCapable: bed.ventilatorCapable,
        negativePressure: bed.negativePressure,
        patient: location?.encounter?.patient ? { id: location.encounter.patient.id, fullName: location.encounter.patient.fullName, uhid: location.encounter.patient.uhid } : null,
        encounterId: location?.encounterId ?? null,
        attending: location?.encounter?.attendingStaff?.user?.displayName ?? null,
        latestVital,
        openTasks,
      };
    })
  );
  return board;
}
