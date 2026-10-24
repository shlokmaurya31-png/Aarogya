import type { RagSourceType, RagWithdrawReason } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { SourceInput } from "./render";
import { isoDay } from "./render";

/**
 * Week 4b — reading a source for the index (docs/RAG_DESIGN.md §5.2): events
 * carry ids only, so the indexer loads each source here, by id, confined to
 * its own facility or Person. The answer is one of:
 *   INDEX     render this (with its owner and version)
 *   WITHDRAW  the source is gone, voided, entered in error, superseded or
 *             rejected: its index goes
 *   NOT_YET   not released / not signed / a draft: nothing to do now
 *   NEVER     never indexed (an ID proof, a patient-provided allergy bridged to
 *             a facility record, which the Person's own entry already covers)
 */
export interface SourceRef { sourceType: RagSourceType; sourceId: string }

export type FacilityOwner = { kind: "FACILITY"; organizationId: string; facilityId: string; patientId: string; encounterId?: string | null };
export type PersonOwner = { kind: "PERSON"; personId: string };

export type Loaded =
  | { action: "INDEX"; owner: FacilityOwner | PersonOwner; input: SourceInput; title?: string; version?: number; supersedes: SourceRef[]; language?: string }
  | { action: "WITHDRAW"; reason: RagWithdrawReason; supersededBy?: SourceRef }
  | { action: "NOT_YET" }
  | { action: "NEVER" };

async function facilityOwner(patientId: string, encounterId?: string | null): Promise<FacilityOwner | null> {
  const p = await prisma.patient.findUnique({ where: { id: patientId }, select: { facilityId: true, facility: { select: { organizationId: true } } } });
  return p ? { kind: "FACILITY", organizationId: p.facility.organizationId, facilityId: p.facilityId, patientId, encounterId: encounterId ?? null } : null;
}

const gone: Loaded = { action: "WITHDRAW", reason: "SOURCE_DELETED" };

/** Imaging modality codes as their display names (codes are expanded, §5.3). */
const MODALITY: Record<string, string> = { XRAY: "X-ray", CT: "CT scan", MRI: "MRI", USG: "Ultrasound", MAMMOGRAPHY: "Mammography", INTERVENTIONAL: "Interventional radiology" };

export async function loadSource(ref: SourceRef): Promise<Loaded> {
  const id = ref.sourceId;
  switch (ref.sourceType) {
    case "CLINICAL_NOTE": {
      const n = await prisma.clinicalNote.findUnique({ where: { id }, select: { type: true, content: true, status: true, signedAt: true, createdAt: true, supersedesId: true, encounter: { select: { patientId: true } } } });
      if (!n) return gone;
      if (n.status === "DRAFT") return { action: "NOT_YET" };
      if (n.status === "SUPERSEDED") return { action: "WITHDRAW", reason: "AMENDED" };
      const owner = await facilityOwner(n.encounter.patientId);
      if (!owner) return gone;
      return { action: "INDEX", owner, input: { sourceType: "CLINICAL_NOTE", noteType: n.type, content: n.content, at: n.signedAt ?? n.createdAt, amended: !!n.supersedesId }, supersedes: n.supersedesId ? [{ sourceType: "CLINICAL_NOTE", sourceId: n.supersedesId }] : [] };
    }
    case "LAB_RESULT": {
      const r = await prisma.labResult.findUnique({ where: { id }, select: { value: true, unit: true, referenceRange: true, abnormalFlag: true, isCritical: true, resultedAt: true, status: true, isCurrent: true, version: true, previousVersionId: true, labOrder: { select: { patientId: true, encounterId: true, testName: true } }, catalogTest: { select: { name: true } } } });
      if (!r) return gone;
      if (r.status === "ENTERED") return { action: "NOT_YET" };
      if (r.status === "SUPERSEDED" || !r.isCurrent) return { action: "WITHDRAW", reason: "AMENDED" };
      const owner = await facilityOwner(r.labOrder.patientId, r.labOrder.encounterId);
      if (!owner) return gone;
      return { action: "INDEX", owner, input: { sourceType: "LAB_RESULT", testName: r.catalogTest?.name ?? r.labOrder.testName, value: r.value, unit: r.unit, referenceRange: r.referenceRange, flag: r.abnormalFlag, critical: r.isCritical, at: r.resultedAt, amended: r.status === "AMENDED" }, supersedes: r.previousVersionId ? [{ sourceType: "LAB_RESULT", sourceId: r.previousVersionId }] : [] };
    }
    case "IMAGING_REPORT": {
      const r = await prisma.imagingReport.findUnique({ where: { id }, select: { indication: true, technique: true, findings: true, impression: true, recommendations: true, reportedAt: true, status: true, isCurrent: true, previousVersionId: true, imagingOrder: { select: { patientId: true, encounterId: true, modality: true, studyDescription: true } } } });
      if (!r) return gone;
      if (r.status === "ENTERED") return { action: "NOT_YET" };
      if (r.status === "SUPERSEDED" || !r.isCurrent) return { action: "WITHDRAW", reason: "AMENDED" };
      const owner = await facilityOwner(r.imagingOrder.patientId, r.imagingOrder.encounterId);
      if (!owner) return gone;
      const study = [MODALITY[r.imagingOrder.modality] ?? r.imagingOrder.modality, r.imagingOrder.studyDescription].filter(Boolean).join(" ") || "Imaging";
      return { action: "INDEX", owner, input: { sourceType: "IMAGING_REPORT", study, indication: r.indication, technique: r.technique, findings: r.findings, impression: r.impression, recommendations: r.recommendations, at: r.reportedAt, amended: r.status === "AMENDED" }, supersedes: r.previousVersionId ? [{ sourceType: "IMAGING_REPORT", sourceId: r.previousVersionId }] : [] };
    }
    case "DIAGNOSIS": {
      const d = await prisma.diagnosis.findUnique({ where: { id } });
      if (!d) return gone;
      if (d.status === "ENTERED_IN_ERROR") return { action: "WITHDRAW", reason: "SOURCE_DELETED" };
      const owner = await facilityOwner(d.patientId, d.encounterId);
      if (!owner) return gone;
      return { action: "INDEX", owner, input: { sourceType: "DIAGNOSIS", diagnosis: d.diagnosis, code: d.code, codeDisplay: d.codeDisplay, type: d.type, status: d.status, onsetDate: d.onsetDate, at: d.createdAt }, supersedes: [] };
    }
    case "PROBLEM": {
      const p = await prisma.problem.findUnique({ where: { id } });
      if (!p) return gone;
      if (p.verificationStatus === "ENTERED_IN_ERROR" || p.verificationStatus === "REFUTED") return { action: "WITHDRAW", reason: "SOURCE_DELETED" };
      const owner = await facilityOwner(p.patientId);
      if (!owner) return gone;
      return { action: "INDEX", owner, input: { sourceType: "PROBLEM", diagnosis: p.diagnosis, code: p.code, codeDisplay: p.codeDisplay, status: p.status, severity: p.severity, onsetDate: p.onsetDate, at: p.createdAt }, supersedes: [] };
    }
    case "ALLERGY": {
      const a = await prisma.allergy.findUnique({ where: { id } });
      if (!a) return gone;
      // A bridged patient-reported allergy is the Person's own entry, indexed as theirs.
      if (a.source === "PATIENT_PROVIDED") return { action: "NEVER" };
      if (a.status === "ENTERED_IN_ERROR") return { action: "WITHDRAW", reason: "SOURCE_DELETED" };
      const owner = await facilityOwner(a.patientId);
      if (!owner) return gone;
      return { action: "INDEX", owner, input: { sourceType: "ALLERGY", substance: a.substance, reaction: a.reaction, severity: a.severity, status: a.status, verification: a.verification, patientReported: false, at: a.recordedAt }, supersedes: [] };
    }
    case "ALLERGY_STATUS": {
      // The record's status: the source id is the patient's; the version is the history's sequence.
      const e = await prisma.allergyStatusEntry.findFirst({ where: { patientId: id }, orderBy: { sequence: "desc" } });
      if (!e) return { action: "NOT_YET" };
      const owner = await facilityOwner(id);
      if (!owner) return gone;
      return { action: "INDEX", owner, version: e.sequence, input: { sourceType: "ALLERGY_STATUS", status: e.status, at: e.recordedAt }, supersedes: [] };
    }
    case "OBSERVATION": {
      // One document per encounter-day of vitals: "<encounterId>:<yyyy-mm-dd>".
      const [encounterId, day] = id.split(":");
      if (!encounterId || !/^\d{4}-\d{2}-\d{2}$/.test(day ?? "")) return { action: "NEVER" };
      const from = new Date(`${day}T00:00:00Z`), to = new Date(from.getTime() + 86_400_000);
      const enc = await prisma.encounter.findUnique({ where: { id: encounterId }, select: { patientId: true } });
      if (!enc) return gone;
      const rows = await prisma.vital.findMany({ where: { encounterId, recordedAt: { gte: from, lt: to } }, orderBy: { recordedAt: "asc" } });
      if (!rows.length) return gone;
      const owner = await facilityOwner(enc.patientId, encounterId);
      if (!owner) return gone;
      return { action: "INDEX", owner, input: { sourceType: "OBSERVATION", day: from, rows: rows.map((r) => ({ at: r.recordedAt, hr: r.hr, sbp: r.sbp, dbp: r.dbp, rr: r.rr, spo2: r.spo2, tempC: r.tempC, painScore: r.painScore })) }, supersedes: [] };
    }
    case "REFERRAL": {
      const r = await prisma.referral.findUnique({ where: { id }, select: { reason: true, priority: true, status: true, notes: true, createdAt: true, patientId: true, encounterId: true, toDepartment: { select: { name: true } } } });
      if (!r) return gone;
      if (r.status === "DRAFT") return { action: "NOT_YET" };
      const owner = await facilityOwner(r.patientId, r.encounterId);
      if (!owner) return gone;
      return { action: "INDEX", owner, input: { sourceType: "REFERRAL", reason: r.reason, to: r.toDepartment?.name ?? null, priority: r.priority, status: r.status, notes: r.notes, at: r.createdAt }, supersedes: [] };
    }
    case "DISCHARGE_SUMMARY": {
      const d = await prisma.discharge.findUnique({ where: { id }, select: { dischargedAt: true, dischargeSummary: true, dischargeType: true, admission: { select: { encounter: { select: { id: true, patientId: true } } } } } });
      if (!d) return gone;
      if (!d.dischargedAt) return { action: "NOT_YET" };
      const owner = await facilityOwner(d.admission.encounter.patientId, d.admission.encounter.id);
      if (!owner) return gone;
      return { action: "INDEX", owner, input: { sourceType: "DISCHARGE_SUMMARY", summary: d.dischargeSummary, dischargeType: d.dischargeType, at: d.dischargedAt }, supersedes: [] };
    }
    case "GENERATED_DOCUMENT":
    case "CLINICAL_DOCUMENT": {
      const c = await prisma.clinicalDocument.findUnique({ where: { id }, select: { type: true, title: true, status: true, accessPolicy: true, createdAt: true, patientId: true, encounterId: true, uploadedByUserId: true, supersedesId: true, generatedDocument: { select: { type: true, isDraft: true } } } });
      if (!c) return gone;
      // A patient's own upload is a person-level document (indexed as theirs), never the facility's.
      if (c.uploadedByUserId) return { action: "NEVER" };
      if (c.status === "DRAFT" || c.generatedDocument?.isDraft) return { action: "NOT_YET" };
      if (c.status === "SUPERSEDED") return { action: "WITHDRAW", reason: "AMENDED" };
      if (c.accessPolicy === "RESTRICTED" || c.type === "ID_PROOF") return { action: "NEVER" };
      const owner = await facilityOwner(c.patientId, c.encounterId);
      if (!owner) return gone;
      return { action: "INDEX", owner, input: { sourceType: ref.sourceType, docType: c.generatedDocument?.type ?? c.type, title: c.title, patientVisible: c.accessPolicy === "PATIENT_VISIBLE", at: c.createdAt }, supersedes: c.supersedesId ? [{ sourceType: ref.sourceType, sourceId: c.supersedesId }] : [] };
    }
    case "PATIENT_PROVIDED_RECORD": {
      const r = await prisma.patientProvidedRecord.findUnique({ where: { id }, select: { personId: true, kind: true, value: true, status: true, effectiveDate: true, createdAt: true, handwritten: true, documentId: true, confirmedByProxy: true } });
      if (!r) return gone;
      if (r.status === "WITHDRAWN") return { action: "WITHDRAW", reason: "REJECTED_BY_PATIENT" };
      if (r.status === "SUPERSEDED") return { action: "WITHDRAW", reason: "AMENDED" };
      const doc = r.documentId ? await prisma.personDocument.findUnique({ where: { id: r.documentId }, select: { title: true } }) : null;
      return { action: "INDEX", owner: { kind: "PERSON", personId: r.personId }, input: { sourceType: "PATIENT_PROVIDED_RECORD", kind: r.kind, value: r.value as Record<string, unknown>, at: r.effectiveDate ?? r.createdAt, handwritten: r.handwritten, documentTitle: doc?.title ?? null, byProxy: r.confirmedByProxy }, supersedes: [] };
    }
    case "PATIENT_DOCUMENT": {
      const d = await prisma.personDocument.findUnique({ where: { id }, select: { personId: true, type: true, title: true, status: true, uploadedAt: true } });
      if (!d) return gone;
      if (d.type === "ID_PROOF") return { action: "NEVER" };
      if (d.status !== "CURRENT") return { action: "WITHDRAW", reason: "REJECTED_BY_PATIENT" };
      return { action: "INDEX", owner: { kind: "PERSON", personId: d.personId }, input: { sourceType: "PATIENT_DOCUMENT", docType: d.type, title: d.title, at: d.uploadedAt }, supersedes: [] };
    }
  }
}

/** The observation source for a vitals row: its encounter-day. */
export function vitalsDaySource(encounterId: string, at: Date): SourceRef {
  return { sourceType: "OBSERVATION", sourceId: `${encounterId}:${isoDay(at)}` };
}
