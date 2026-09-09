import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { getPacsAdapter } from "@/lib/hospital/pacsAdapter";
import type { Prisma, LabQcReviewStatus, ExternalLabStatus } from "@prisma/client";

/**
 * Advanced Diagnostics service (Phase B7). Operational depth ON TOP of the
 * existing Phase 4 diagnostics core — the Specimen/LabResult/ImagingStudy/
 * ImagingReport lifecycles (specimenLifecycle.ts / labResultLifecycle.ts /
 * imagingStudyLifecycle.ts / imagingReportLifecycle.ts) are REUSED, not
 * rebuilt. This adds: specimen barcode identity, laboratory QC + calibration
 * documentation, the external-lab referral boundary, and the radiology DICOM/
 * PACS metadata boundary. NO clinical interpretation, NO invented reference
 * ranges, NO AI. Every mutation re-validates facility ownership server-side.
 */

// ── Specimen barcode identity ───────────────────────────────────────────────
export async function setSpecimenIdentity(input: { specimenId: string; facilityId: string; barcode?: string; containerType?: string; byUserId: string }) {
  const specimen = await prisma.specimen.findUnique({ where: { id: input.specimenId } });
  if (!specimen || specimen.facilityId !== input.facilityId) throw new NotFoundError("Specimen not found in this facility.");
  const barcode = input.barcode ?? specimen.barcode ?? specimen.accessionNumber; // default the scannable value to the accession
  const updated = await prisma.specimen.update({ where: { id: specimen.id }, data: { barcode, containerType: input.containerType ?? specimen.containerType } });
  await recordAuditEvent("hospital.lab.specimenIdentitySet", input.byUserId, { specimenId: specimen.id, barcode }, { facilityId: specimen.facilityId, patientId: specimen.patientId, encounterId: specimen.encounterId });
  return updated;
}

/**
 * Barcode/accession lookup, ALWAYS facility-scoped. A barcode is never
 * sufficient authorization: the caller's facility bounds the query and the
 * returned record still carries patient/encounter/order for the caller to
 * authorize the intended mutation. Matches either the scannable barcode or the
 * human-readable accession.
 */
export async function lookupSpecimen(facilityId: string, code: string) {
  const specimen = await prisma.specimen.findFirst({
    where: { facilityId, OR: [{ barcode: code }, { accessionNumber: code }] },
    include: { patient: true, labOrder: true },
  });
  if (!specimen) throw new NotFoundError("No specimen matches that barcode/accession in this facility.");
  return specimen;
}

// ── Laboratory QC ────────────────────────────────────────────────────────────
const QC_REVIEW_TRANSITIONS: Record<LabQcReviewStatus, LabQcReviewStatus[]> = {
  PENDING: ["REVIEWED", "REJECTED"],
  REVIEWED: [],
  REJECTED: [],
};

export async function recordQc(input: { facilityId: string; instrumentId: string; controlType: string; catalogTestId?: string; controlLot?: string; observedValue?: number; expectedValue?: number; unit?: string; result?: string; performedByStaffId: string; notes?: string; runAt?: Date; byUserId: string }) {
  if (!input.instrumentId || !input.controlType) throw new BadRequestError("instrumentId and controlType are required.");
  const qc = await prisma.labQcRecord.create({
    data: { facilityId: input.facilityId, instrumentId: input.instrumentId, controlType: input.controlType, catalogTestId: input.catalogTestId, controlLot: input.controlLot, observedValue: input.observedValue, expectedValue: input.expectedValue, unit: input.unit, result: input.result, performedByStaffId: input.performedByStaffId, notes: input.notes, runAt: input.runAt ?? new Date() },
  });
  await recordAuditEvent("hospital.lab.qcRecorded", input.byUserId, { qcId: qc.id, instrumentId: input.instrumentId, result: input.result }, { facilityId: input.facilityId });
  return qc;
}

export async function reviewQc(input: { qcId: string; facilityId: string; to: "REVIEWED" | "REJECTED"; reviewedByStaffId: string; notes?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const qc = await tx.labQcRecord.findUnique({ where: { id: input.qcId } });
    if (!qc || qc.facilityId !== input.facilityId) throw new NotFoundError("QC record not found.");
    if (!(QC_REVIEW_TRANSITIONS[qc.status]?.includes(input.to) ?? false)) throw new BadRequestError(`QC record is already ${qc.status}.`);
    const r = await tx.labQcRecord.updateMany({ where: { id: qc.id, status: "PENDING" }, data: { status: input.to, reviewedByStaffId: input.reviewedByStaffId, reviewedAt: new Date(), ...(input.notes !== undefined ? { notes: input.notes } : {}) } });
    if (r.count !== 1) throw new BadRequestError("QC record was reviewed concurrently — refresh and try again.");
    await tx.auditEvent.create({ data: { type: "hospital.lab.qcReviewed", userId: input.byUserId, detail: { qcId: qc.id, to: input.to }, facilityId: qc.facilityId } });
    return tx.labQcRecord.findUniqueOrThrow({ where: { id: qc.id } });
  });
}

// ── Instrument calibration ───────────────────────────────────────────────────
export async function recordCalibration(input: { facilityId: string; instrumentId: string; calibrationType: string; performedByStaffId: string; calibratedAt?: Date; nextDueAt?: Date; notes?: string; byUserId: string }) {
  if (!input.instrumentId || !input.calibrationType) throw new BadRequestError("instrumentId and calibrationType are required.");
  const cal = await prisma.labCalibrationRecord.create({
    data: { facilityId: input.facilityId, instrumentId: input.instrumentId, calibrationType: input.calibrationType, performedByStaffId: input.performedByStaffId, calibratedAt: input.calibratedAt ?? new Date(), nextDueAt: input.nextDueAt, notes: input.notes },
  });
  await recordAuditEvent("hospital.lab.calibrationRecorded", input.byUserId, { calibrationId: cal.id, instrumentId: input.instrumentId }, { facilityId: input.facilityId });
  return cal;
}

export async function reviewCalibration(input: { calibrationId: string; facilityId: string; to: "REVIEWED" | "REJECTED"; reviewedByStaffId: string; notes?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const cal = await tx.labCalibrationRecord.findUnique({ where: { id: input.calibrationId } });
    if (!cal || cal.facilityId !== input.facilityId) throw new NotFoundError("Calibration record not found.");
    if (cal.status !== "PENDING") throw new BadRequestError(`Calibration record is already ${cal.status}.`);
    const r = await tx.labCalibrationRecord.updateMany({ where: { id: cal.id, status: "PENDING" }, data: { status: input.to, reviewedByStaffId: input.reviewedByStaffId, reviewedAt: new Date(), ...(input.notes !== undefined ? { notes: input.notes } : {}) } });
    if (r.count !== 1) throw new BadRequestError("Calibration record was reviewed concurrently — refresh and try again.");
    await tx.auditEvent.create({ data: { type: "hospital.lab.calibrationReviewed", userId: input.byUserId, detail: { calibrationId: cal.id, to: input.to }, facilityId: cal.facilityId } });
    return tx.labCalibrationRecord.findUniqueOrThrow({ where: { id: cal.id } });
  });
}

// ── External laboratory referral boundary ────────────────────────────────────
const EXTERNAL_TRANSITIONS: Record<ExternalLabStatus, ExternalLabStatus[]> = {
  DRAFT: ["SENT", "CANCELLED"],
  SENT: ["RESULT_RECEIVED", "CANCELLED"],
  RESULT_RECEIVED: ["REVIEWED"],
  REVIEWED: [],
  CANCELLED: [],
};

/** Pure predicates (exported for unit testing without a DB). */
export function isExternalReferralTransitionAllowed(from: ExternalLabStatus, to: ExternalLabStatus): boolean {
  return EXTERNAL_TRANSITIONS[from]?.includes(to) ?? false;
}
export function isQcReviewTransitionAllowed(from: LabQcReviewStatus, to: LabQcReviewStatus): boolean {
  return QC_REVIEW_TRANSITIONS[from]?.includes(to) ?? false;
}

export async function createExternalReferral(input: { facilityId: string; patientId: string; externalLabName: string; labOrderId?: string; encounterId?: string; externalAccession?: string; testDescription?: string; sentByStaffId: string; notes?: string; byUserId: string }) {
  const patient = await prisma.patient.findUnique({ where: { id: input.patientId } });
  if (!patient || patient.facilityId !== input.facilityId) throw new NotFoundError("Patient not found in this facility.");
  if (input.labOrderId) {
    const order = await prisma.labOrder.findUnique({ where: { id: input.labOrderId }, include: { encounter: true } });
    if (!order || order.encounter.facilityId !== input.facilityId || order.patientId !== input.patientId) throw new NotFoundError("Lab order not found for this patient/facility.");
  }
  const referral = await prisma.externalLabReferral.create({
    data: { facilityId: input.facilityId, patientId: input.patientId, labOrderId: input.labOrderId, encounterId: input.encounterId, externalLabName: input.externalLabName, externalAccession: input.externalAccession, testDescription: input.testDescription, sentByStaffId: input.sentByStaffId, notes: input.notes },
  });
  await recordAuditEvent("hospital.lab.externalReferralCreated", input.byUserId, { referralId: referral.id, externalLabName: input.externalLabName }, { facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId });
  return referral;
}

export async function transitionExternalReferral(input: { referralId: string; facilityId: string; to: ExternalLabStatus; actorStaffId: string; externalAccession?: string; resultDocumentRef?: string; notes?: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const referral = await tx.externalLabReferral.findUnique({ where: { id: input.referralId } });
    if (!referral || referral.facilityId !== input.facilityId) throw new NotFoundError("External referral not found.");
    if (!(EXTERNAL_TRANSITIONS[referral.status]?.includes(input.to) ?? false)) throw new BadRequestError(`Illegal external-referral transition ${referral.status} -> ${input.to}.`);
    const data: Prisma.ExternalLabReferralUpdateManyMutationInput = { status: input.to };
    if (input.to === "SENT") data.sentAt = new Date();
    if (input.to === "RESULT_RECEIVED") { data.resultReceivedAt = new Date(); if (input.resultDocumentRef) data.resultDocumentRef = input.resultDocumentRef; if (input.externalAccession) data.externalAccession = input.externalAccession; }
    if (input.to === "REVIEWED") { data.reviewedByStaffId = input.actorStaffId; data.reviewedAt = new Date(); }
    if (input.notes !== undefined) data.notes = input.notes;
    const r = await tx.externalLabReferral.updateMany({ where: { id: referral.id, status: referral.status }, data });
    if (r.count !== 1) throw new BadRequestError("External referral changed state concurrently — refresh and try again.");
    await tx.auditEvent.create({ data: { type: "hospital.lab.externalReferralUpdated", userId: input.byUserId, detail: { referralId: referral.id, from: referral.status, to: input.to }, facilityId: referral.facilityId, patientId: referral.patientId } });
    return tx.externalLabReferral.findUniqueOrThrow({ where: { id: referral.id } });
  });
}

// ── Radiology DICOM / PACS acquisition boundary ──────────────────────────────
/**
 * Record a study's acquisition + DICOM/PACS metadata (technologist workflow,
 * brief §23-25). Goes through the PACS adapter boundary for the external
 * reference; stores only metadata, never image bytes. Guarded: only a study
 * that has been started/completed can have acquisition recorded, and the
 * updateMany precondition makes concurrent acquisition recording single-effect.
 */
export async function recordStudyAcquisition(input: {
  studyId: string; facilityId: string; performedByStaffId: string;
  studyInstanceUid?: string; seriesUid?: string; numberOfImages?: number; technicalNotes?: string; dicomMetadata?: Prisma.InputJsonValue; byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const study = await tx.imagingStudy.findUnique({ where: { id: input.studyId } });
    if (!study || study.facilityId !== input.facilityId) throw new NotFoundError("Imaging study not found in this facility.");
    if (study.status !== "IN_PROGRESS" && study.status !== "COMPLETED") throw new BadRequestError(`Acquisition can only be recorded for an in-progress or completed study (current: ${study.status}).`);

    const pacs = await getPacsAdapter().registerStudy({ facilityId: study.facilityId, accessionNumber: study.accessionNumber, studyInstanceUid: input.studyInstanceUid, seriesUid: input.seriesUid, modality: study.modality });

    const r = await tx.imagingStudy.updateMany({
      where: { id: study.id, status: study.status },
      data: {
        studyInstanceUid: input.studyInstanceUid ?? study.studyInstanceUid, seriesUid: input.seriesUid, numberOfImages: input.numberOfImages,
        pacsReference: pacs.pacsReference, imageAvailability: pacs.imageAvailability, acquisitionAt: new Date(),
        performedByStaffId: study.performedByStaffId ?? input.performedByStaffId, technicalNotes: input.technicalNotes,
        ...(input.dicomMetadata !== undefined ? { dicomMetadata: input.dicomMetadata } : {}),
      },
    });
    if (r.count !== 1) throw new BadRequestError("Study changed state concurrently — refresh and try again.");
    await tx.auditEvent.create({ data: { type: "hospital.imaging.acquisitionRecorded", userId: input.byUserId, detail: { studyId: study.id, accessionNumber: study.accessionNumber, pacsReference: pacs.pacsReference, images: input.numberOfImages }, facilityId: study.facilityId, patientId: study.patientId, encounterId: study.encounterId } });
    return tx.imagingStudy.findUniqueOrThrow({ where: { id: study.id } });
  });
}

// ── Composition: advanced command-center counts + worklists ──────────────────
export async function getAdvancedDiagnosticsCounts(facilityId: string) {
  const now = new Date();
  const soon = new Date(now.getTime() + 7 * 24 * 3600_000);
  const [qcPending, calPending, calDueSoon, externalPending, externalDraft, studiesAwaitingAcquisition, studiesAcquired] = await Promise.all([
    prisma.labQcRecord.count({ where: { facilityId, status: "PENDING" } }),
    prisma.labCalibrationRecord.count({ where: { facilityId, status: "PENDING" } }),
    prisma.labCalibrationRecord.count({ where: { facilityId, nextDueAt: { not: null, lte: soon } } }),
    prisma.externalLabReferral.count({ where: { facilityId, status: { in: ["SENT", "RESULT_RECEIVED"] } } }),
    prisma.externalLabReferral.count({ where: { facilityId, status: "DRAFT" } }),
    prisma.imagingStudy.count({ where: { facilityId, status: "IN_PROGRESS", acquisitionAt: null } }),
    prisma.imagingStudy.count({ where: { facilityId, acquisitionAt: { not: null } } }),
  ]);
  return {
    lab: { qcPendingReview: qcPending, calibrationPendingReview: calPending, calibrationDueSoon: calDueSoon, externalPending, externalDraft },
    radiology: { studiesAwaitingAcquisition, studiesAcquired },
  };
}

export async function listQc(facilityId: string, status?: LabQcReviewStatus) {
  return prisma.labQcRecord.findMany({ where: { facilityId, ...(status ? { status } : {}) }, orderBy: { runAt: "desc" }, take: 200 });
}
export async function listCalibration(facilityId: string, status?: LabQcReviewStatus) {
  return prisma.labCalibrationRecord.findMany({ where: { facilityId, ...(status ? { status } : {}) }, orderBy: { calibratedAt: "desc" }, take: 200 });
}
export async function listExternalReferrals(facilityId: string, status?: ExternalLabStatus) {
  return prisma.externalLabReferral.findMany({ where: { facilityId, ...(status ? { status } : {}) }, orderBy: { createdAt: "desc" }, take: 200 });
}

/** Radiology technician worklist enriched with acquisition/PACS state (bounded, indexed). */
export async function getRadiologyAcquisitionWorklist(facilityId: string) {
  const studies = await prisma.imagingStudy.findMany({
    where: { facilityId, status: { in: ["ARRIVED", "IN_PROGRESS", "COMPLETED"] } },
    include: { patient: true, resource: true, imagingOrder: true },
    orderBy: { scheduledAt: "asc" }, take: 100,
  });
  return studies.map((s) => ({
    studyId: s.id, imagingOrderId: s.imagingOrderId, accessionNumber: s.accessionNumber, modality: s.modality, status: s.status,
    patient: { id: s.patient.id, fullName: s.patient.fullName, uhid: s.patient.uhid },
    resource: s.resource?.name ?? null, scheduledAt: s.scheduledAt,
    acquired: s.acquisitionAt != null, imageAvailability: s.imageAvailability, numberOfImages: s.numberOfImages,
    pacsReference: s.pacsReference, studyInstanceUid: s.studyInstanceUid, studyDescription: s.imagingOrder.studyDescription,
  }));
}
