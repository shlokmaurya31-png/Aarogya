import type { PatientProvidedRecord, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { personAccess, personDecision, requireOwnedPerson, SHARE_UPLOADS } from "@/lib/person/access";

type Tx = Prisma.TransactionClient;

/**
 * Week 4a — patient-provided entries against verified records
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §8). Detection only: nothing is ever
 * overwritten, in either direction. Each conflicting pair is one
 * RecordConflict per facility record (idempotent on the pair), shown to the
 * person and — under the same opt-in and care relationship that lets them
 * see the entry — to that facility's clinicians, verified value first.
 *
 *   LAB_RESULT          same analyte (normalized name) within ±1 day of the
 *                       verified result, with a different value or unit
 *   ALLERGY             the facility marked the same substance ENTERED_IN_ERROR
 *                       or INACTIVE (the schema has no verified "no known
 *                       allergies" record, so that rule has nothing to read yet)
 *   MEDICATION_HISTORY  the same drug in a verified active order overlapping the
 *                       entry's date (or now, when it has none), with a
 *                       different dose or frequency
 *   DIAGNOSIS           the same ICD-10 code or normalized text, verified
 *                       RESOLVED or ENTERED_IN_ERROR, while the entry says active,
 *                       dated after the verified diagnosis (or undated)
 *
 * Pending clinical advisor: these rules (docs/PRE_LAUNCH_CHECKLIST.md item 2).
 */

const DAY = 86_400_000;
const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFKC").replace(/haem/g, "hem").replace(/[^\p{L}\p{N}]+/gu, "");
const normUnit = (s: unknown) => String(s ?? "").toLowerCase().replace(/\s+/g, "").replace(/μ/g, "µ").replace(/^u(?=[a-z]*\/)/, "µ");
const FREQ: Record<string, string> = { "1-0-0": "od", "0-0-1": "hs", "1-0-1": "bd", "1-1-1": "tds", "1-1-1-1": "qid", od: "od", bd: "bd", bid: "bd", tds: "tds", tid: "tds", qid: "qid", hs: "hs", sos: "sos", prn: "sos" };
const normFreq = (s: unknown) => { const k = String(s ?? "").toLowerCase().replace(/\s+/g, ""); return FREQ[k] ?? k; };
const sameNumberOrText = (a: unknown, b: unknown) => {
  const x = Number(String(a).trim()), y = Number(String(b).trim());
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : norm(a) === norm(b);
};

interface Found { verifiedSourceType: "LabResult" | "Allergy" | "MedicationOrder" | "Diagnosis"; verifiedSourceId: string; patientId: string; facilityId: string }

async function linkedPatients(tx: Tx, personId: string) {
  return tx.personPatientLink.findMany({ where: { personId, status: "ACTIVE" }, select: { patientId: true, facilityId: true } });
}

async function detect(tx: Tx, rec: PatientProvidedRecord): Promise<Found[]> {
  const v = rec.value as Record<string, unknown>;
  const links = await linkedPatients(tx, rec.personId);
  const facilityOf = new Map(links.map((l) => [l.patientId, l.facilityId]));
  const patientIds = links.map((l) => l.patientId);
  if (!patientIds.length) return [];
  const out: Found[] = [];
  const push = (t: Found["verifiedSourceType"], id: string, patientId: string) => out.push({ verifiedSourceType: t, verifiedSourceId: id, patientId, facilityId: facilityOf.get(patientId)! });

  if (rec.kind === "LAB_RESULT" && rec.effectiveDate) {
    const from = new Date(rec.effectiveDate.getTime() - DAY), to = new Date(rec.effectiveDate.getTime() + 2 * DAY);
    const results = await tx.labResult.findMany({
      where: { isCurrent: true, status: { in: ["VERIFIED", "AMENDED"] }, resultedAt: { gte: from, lt: to }, labOrder: { patientId: { in: patientIds } } },
      select: { id: true, value: true, unit: true, labOrder: { select: { patientId: true, testName: true } }, catalogTest: { select: { name: true } } },
    });
    for (const r of results) {
      if (norm(r.catalogTest?.name ?? r.labOrder.testName) !== norm(v.analyte)) continue;
      if (!sameNumberOrText(r.value, v.value) || (r.unit && normUnit(r.unit) !== normUnit(v.unit))) push("LabResult", r.id, r.labOrder.patientId);
    }
  }
  if (rec.kind === "ALLERGY") {
    const rows = await tx.allergy.findMany({ where: { patientId: { in: patientIds }, source: "CLINICIAN", status: { in: ["ENTERED_IN_ERROR", "INACTIVE"] } }, select: { id: true, substance: true, patientId: true } });
    for (const a of rows) if (norm(a.substance) === norm(v.substance)) push("Allergy", a.id, a.patientId);
  }
  if (rec.kind === "MEDICATION_HISTORY") {
    const at = rec.effectiveDate ?? new Date();
    const orders = await tx.medicationOrder.findMany({
      where: { patientId: { in: patientIds }, status: { in: ["VERIFIED", "DISPENSED", "ACTIVE"] } },
      select: { id: true, patientId: true, drugName: true, genericName: true, dose: true, frequency: true, orderedAt: true, startAt: true, stopAt: true, discontinuedAt: true },
    });
    for (const o of orders) {
      if (norm(o.drugName) !== norm(v.name) && norm(o.genericName) !== norm(v.name)) continue;
      const start = o.startAt ?? o.orderedAt, stop = o.stopAt ?? o.discontinuedAt;
      if (at < new Date(start.getTime() - DAY) || (stop && at > stop)) continue;
      if (norm(o.dose) !== norm(v.dose) || normFreq(o.frequency) !== normFreq(v.frequency)) push("MedicationOrder", o.id, o.patientId);
    }
  }
  if (rec.kind === "DIAGNOSIS" && (v.status === undefined || v.status === "ACTIVE")) {
    const rows = await tx.diagnosis.findMany({ where: { patientId: { in: patientIds }, status: { in: ["RESOLVED", "ENTERED_IN_ERROR"] } }, select: { id: true, patientId: true, diagnosis: true, code: true, createdAt: true } });
    for (const d of rows) {
      const same = (v.icd10 && d.code && String(v.icd10).toUpperCase() === d.code.toUpperCase()) || norm(d.diagnosis) === norm(v.text);
      if (same && (!rec.effectiveDate || rec.effectiveDate > d.createdAt)) push("Diagnosis", d.id, d.patientId);
    }
  }
  return out;
}

/** doc-conflicts: checks one entry; new conflicts are recorded once and announced to their facility. */
export async function checkRecordConflicts(recordId: string) {
  return prisma.$transaction(async (tx) => {
    const rec = await tx.patientProvidedRecord.findUnique({ where: { id: recordId } });
    if (!rec || rec.status !== "ACTIVE") return 0;
    let n = 0;
    for (const f of await detect(tx, rec)) {
      const existing = await tx.recordConflict.findUnique({ where: { patientProvidedRecordId_verifiedSourceType_verifiedSourceId: { patientProvidedRecordId: rec.id, verifiedSourceType: f.verifiedSourceType, verifiedSourceId: f.verifiedSourceId } } });
      if (existing) continue;
      const c = await tx.recordConflict.create({ data: { personId: rec.personId, facilityId: f.facilityId, patientId: f.patientId, kind: rec.kind, patientProvidedRecordId: rec.id, verifiedSourceType: f.verifiedSourceType, verifiedSourceId: f.verifiedSourceId } });
      await emitFacilityEvent(tx, {
        type: "RecordConflictDetected", aggregateId: c.id, facilityId: f.facilityId, personId: rec.personId,
        payload: { conflictId: c.id, personId: rec.personId, patientId: f.patientId, kind: rec.kind, patientProvidedRecordId: rec.id, verifiedSourceType: f.verifiedSourceType, verifiedSourceId: f.verifiedSourceId },
      });
      n += 1;
    }
    return n;
  });
}

/** A verified record changed for a facility patient: re-check the linked person's entries of that kind. */
export async function recheckForPatient(patientId: string, kind: PatientProvidedRecord["kind"]) {
  const persons = await prisma.personPatientLink.findMany({ where: { patientId, status: "ACTIVE" }, select: { personId: true } });
  let n = 0;
  for (const { personId } of persons) {
    for (const r of await prisma.patientProvidedRecord.findMany({ where: { personId, kind, status: "ACTIVE" }, select: { id: true } })) n += await checkRecordConflicts(r.id);
  }
  return n;
}

// ── Display (§8.2): the verified value first ────────────────────────────────

async function verifiedSummary(type: string, id: string): Promise<Record<string, unknown> | null> {
  if (type === "LabResult") {
    const r = await prisma.labResult.findUnique({ where: { id }, select: { value: true, unit: true, referenceRange: true, resultedAt: true, labOrder: { select: { testName: true } }, catalogTest: { select: { name: true } } } });
    return r && { analyte: r.catalogTest?.name ?? r.labOrder.testName, value: r.value, unit: r.unit, referenceRange: r.referenceRange, date: r.resultedAt };
  }
  if (type === "Allergy") {
    const a = await prisma.allergy.findUnique({ where: { id }, select: { substance: true, status: true, recordedAt: true } });
    return a && { substance: a.substance, status: a.status, date: a.recordedAt };
  }
  if (type === "MedicationOrder") {
    const o = await prisma.medicationOrder.findUnique({ where: { id }, select: { drugName: true, dose: true, frequency: true, route: true, status: true, orderedAt: true } });
    return o && { name: o.drugName, dose: o.dose, frequency: o.frequency, route: o.route, status: o.status, date: o.orderedAt };
  }
  const d = await prisma.diagnosis.findUnique({ where: { id }, select: { diagnosis: true, code: true, status: true, createdAt: true } });
  return d && { text: d.diagnosis, icd10: d.code, status: d.status, date: d.createdAt };
}

async function present(c: { id: string; kind: string; status: string; detectedAt: Date; patientProvidedRecordId: string; verifiedSourceType: string; verifiedSourceId: string; facilityId: string }) {
  const rec = await prisma.patientProvidedRecord.findUnique({ where: { id: c.patientProvidedRecordId }, select: { value: true, documentId: true, pageNo: true, region: true, handwritten: true, effectiveDate: true } });
  return {
    id: c.id, kind: c.kind, status: c.status, detectedAt: c.detectedAt, facilityId: c.facilityId,
    verified: { source: "VERIFIED" as const, type: c.verifiedSourceType, value: await verifiedSummary(c.verifiedSourceType, c.verifiedSourceId) },
    patientProvided: rec && { source: "PATIENT_PROVIDED" as const, label: "Your uploaded report says", value: rec.value, documentId: rec.documentId, pageNo: rec.pageNo, region: rec.region, handwritten: rec.handwritten, effectiveDate: rec.effectiveDate },
  };
}

/** The person's own conflicts (all facilities), verified first. */
export async function listOwnConflicts(userId: string) {
  const personId = await requireOwnedPerson(userId);
  const rows = await prisma.recordConflict.findMany({ where: { personId, status: { not: "RESOLVED_BY_CLINICIAN" } }, orderBy: { detectedAt: "desc" } });
  return Promise.all(rows.map(present));
}

/** A facility's conflicts for these records: only where its staff may see the patient-provided entry. */
export async function facilityConflicts(facilityId: string, patientIds: string[]) {
  const rows = await prisma.recordConflict.findMany({ where: { facilityId, patientId: { in: patientIds }, status: { not: "RESOLVED_BY_CLINICIAN" } }, orderBy: { detectedAt: "desc" } });
  const out = [];
  for (const c of rows) {
    if ((await personDecision(c.personId, SHARE_UPLOADS)) !== "GRANTED") continue;
    if (!(await personAccess({ kind: "STAFF", userId: "", facilityId }, c.personId, "UPLOADS"))) continue;
    out.push(await present(c));
  }
  return out;
}

/** A clinician acknowledges a conflict (resolving it is recording a verified entry). Never changes either record. */
export async function acknowledgeConflict(input: { conflictId: string; facilityId: string; staffId: string; resolved?: boolean }) {
  const c = await prisma.recordConflict.findUnique({ where: { id: input.conflictId } });
  if (!c || c.facilityId !== input.facilityId) throw new NotFoundError();
  const to = input.resolved ? "RESOLVED_BY_CLINICIAN" : "ACKNOWLEDGED";
  await prisma.$transaction(async (tx) => {
    const r = await tx.recordConflict.updateMany({ where: { id: c.id, status: { in: input.resolved ? ["OPEN", "ACKNOWLEDGED"] : ["OPEN"] } }, data: { status: to, acknowledgedByStaffId: input.staffId, acknowledgedAt: new Date() } });
    if (r.count !== 1) throw new ConflictError("This conflict has already been handled.");
    await emitFacilityEvent(tx, { type: "RecordConflictAcknowledged", aggregateId: c.id, facilityId: c.facilityId, personId: c.personId, payload: { conflictId: c.id, patientId: c.patientId, status: to, staffId: input.staffId } });
  });
  await recordAuditEvent("record.conflict.acknowledged", null, { conflictId: c.id, facilityId: c.facilityId, staffId: input.staffId, status: to });
  return { status: to };
}
