import type { ExtractedFact, PatientProvidedRecord, Prisma, Severity } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { NotFoundError } from "@/lib/auth/rbac";
import { emitDomainEvent } from "@/lib/events/emit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { personAccess, personDecision, requireOwnedPerson, SHARE_UPLOADS } from "@/lib/person/access";
import { RECORD_KIND } from "./factSchemas";
import { moveRun } from "./pipelineState";

type Tx = Prisma.TransactionClient;

/**
 * Week 4a — confirmed facts into the record (docs/DOCUMENT_PIPELINE_DESIGN.md
 * §2.6, §3). A CONFIRMED or CORRECTED fact becomes one PatientProvidedRecord
 * (source PATIENT_PROVIDED, with provenance back to the fact, the original
 * page and its region); never a hospital Diagnosis, LabResult or medication
 * row, which would need invented encounters and orders. DOCUMENT_META never
 * becomes an entry; REJECTED facts are kept (for evaluation), never merged.
 *
 * Allergies are also bridged, for prescribing safety, to an Allergy row
 * (UNCONFIRMED, source PATIENT_PROVIDED) at each facility where the person has
 * an ACTIVE link AND shares uploads with treating hospitals. When that stops
 * (the record withdrawn, the sharing declined, the link ended), bridged rows
 * no clinician confirmed go INACTIVE and the facility gets a content-free
 * notice ("allergy information withdrawn by the patient — ask about
 * allergies"); rows a clinician confirmed are the facility's own and stay.
 */

/** Day-first dates (dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy: the Indian convention) and ISO dates; anything else is no date. */
export function parseDocumentDate(s: unknown): Date | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  let y: number, m: number, d: number;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const dmy = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
  else return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}

const SEVERITY: Record<string, Severity> = { mild: "MILD", moderate: "MODERATE", severe: "SEVERE" };

async function documentDate(tx: Tx, processingId: string): Promise<unknown> {
  const meta = await tx.extractedFact.findFirst({ where: { processingId, factType: "DOCUMENT_META", reviewStatus: { in: ["CONFIRMED", "CORRECTED"] } }, orderBy: { pageNo: "asc" } });
  const v = (meta?.reviewedValue ?? meta?.value) as Record<string, unknown> | undefined;
  return v?.documentDate;
}

/** Bridges an ACTIVE allergy record to the facilities that may see it (idempotent per facility record). */
export async function bridgeAllergy(tx: Tx, record: PatientProvidedRecord) {
  if (record.kind !== "ALLERGY" || record.status !== "ACTIVE") return 0;
  if ((await personDecision(record.personId, SHARE_UPLOADS)) !== "GRANTED") return 0;
  const v = record.value as { substance: string; reaction?: string; severity?: string };
  const links = await tx.personPatientLink.findMany({ where: { personId: record.personId, status: "ACTIVE" }, select: { patientId: true, facilityId: true } });
  let n = 0;
  for (const l of links) {
    const existing = await tx.allergy.findFirst({ where: { patientId: l.patientId, patientProvidedRecordId: record.id } });
    if (existing) {
      // Taken back earlier (sharing declined, link ended) and nobody confirmed or rejected it since: active again.
      if (existing.status === "INACTIVE" && existing.verification === "UNCONFIRMED") {
        await tx.allergy.update({ where: { id: existing.id }, data: { status: "ACTIVE" } });
        await emitFacilityEvent(tx, {
          type: "AllergyListUpdated", aggregateId: existing.id, facilityId: l.facilityId, personId: record.personId,
          payload: { allergyId: existing.id, patientId: existing.patientId, action: "UPDATED", status: "ACTIVE", ...(existing.severity ? { severity: existing.severity } : {}), verification: existing.verification, ...(existing.criticality ? { criticality: existing.criticality } : {}), source: "PATIENT_PROVIDED" },
        });
        n += 1;
      }
      continue;
    }
    const severity = v.severity ? SEVERITY[v.severity.trim().toLowerCase()] ?? null : null;
    const a = await tx.allergy.create({
      data: {
        patientId: l.patientId, substance: v.substance, reaction: v.reaction ?? null, severity, verification: "UNCONFIRMED",
        // Unknown severity is never guessed; the criticality says it wasn't assessed.
        criticality: severity ? null : "UNABLE_TO_ASSESS", source: "PATIENT_PROVIDED", patientProvidedRecordId: record.id,
      },
    });
    await emitFacilityEvent(tx, {
      type: "AllergyListUpdated", aggregateId: a.id, facilityId: l.facilityId, personId: record.personId,
      payload: { allergyId: a.id, patientId: a.patientId, action: "ADDED", status: a.status, ...(a.severity ? { severity: a.severity } : {}), verification: a.verification, ...(a.criticality ? { criticality: a.criticality } : {}), source: "PATIENT_PROVIDED" },
    });
    n += 1;
  }
  return n;
}

/**
 * Takes back bridged allergies no clinician confirmed (INACTIVE), leaving the
 * facility record a content-free notice. `where` narrows to one record or one
 * facility record; confirmed rows always stay.
 */
export async function withdrawAllergyBridges(tx: Tx, personId: string, where: { patientProvidedRecordId?: string; patientId?: string }) {
  const recordIds = (await tx.patientProvidedRecord.findMany({ where: { personId, kind: "ALLERGY", ...(where.patientProvidedRecordId ? { id: where.patientProvidedRecordId } : {}) }, select: { id: true } })).map((r) => r.id);
  if (!recordIds.length) return 0;
  const rows = await tx.allergy.findMany({
    where: { source: "PATIENT_PROVIDED", patientProvidedRecordId: { in: recordIds }, verification: "UNCONFIRMED", status: "ACTIVE", ...(where.patientId ? { patientId: where.patientId } : {}) },
    include: { patient: { select: { facilityId: true } } },
  });
  for (const a of rows) {
    const r = await tx.allergy.updateMany({ where: { id: a.id, status: "ACTIVE", verification: "UNCONFIRMED" }, data: { status: "INACTIVE" } });
    if (r.count !== 1) continue;
    await emitFacilityEvent(tx, {
      type: "AllergyListUpdated", aggregateId: a.id, facilityId: a.patient.facilityId, personId,
      payload: { allergyId: a.id, patientId: a.patientId, action: "INACTIVATED", status: "INACTIVE", ...(a.severity ? { severity: a.severity } : {}), verification: a.verification, ...(a.criticality ? { criticality: a.criticality } : {}), source: "PATIENT_PROVIDED" },
    });
    if (!(await tx.patientAllergyNotice.findFirst({ where: { patientId: a.patientId, kind: "WITHDRAWN_BY_PATIENT", resolvedAt: null }, select: { id: true } }))) {
      await tx.patientAllergyNotice.create({ data: { facilityId: a.patient.facilityId, patientId: a.patientId, kind: "WITHDRAWN_BY_PATIENT" } });
    }
  }
  return rows.length;
}

/** doc-merge: one reviewed fact into the record (idempotent: one entry per fact). */
export async function mergeReviewedFact(factId: string) {
  await prisma.$transaction(async (tx) => {
    const f = await tx.extractedFact.findUnique({ where: { id: factId }, include: { processing: { select: { id: true, documentId: true, status: true } } } });
    // A cancelled run (the upload withdrawn) merges nothing. A completed one may still have a
    // redelivered event: the fact is then already merged (one entry per fact).
    if (!f || (f.processing.status !== "AWAITING_REVIEW" && f.processing.status !== "COMPLETED")) return;
    await mergeOne(tx, f, f.processing.documentId);
    await completeIfReviewed(tx, f.processingId, f.personId, f.processing.documentId);
  });
}

async function mergeOne(tx: Tx, f: ExtractedFact, documentId: string) {
  const kind = RECORD_KIND[f.factType];
  if (kind && (f.reviewStatus === "CONFIRMED" || f.reviewStatus === "CORRECTED") && !f.recordEntryId) await addRecord(tx, f, kind, documentId);
}

async function addRecord(tx: Tx, f: ExtractedFact, kind: NonNullable<(typeof RECORD_KIND)[keyof typeof RECORD_KIND]>, documentId: string) {
  const value = (f.reviewedValue ?? f.value) as Record<string, unknown>;
  const own = value.specimenDate ?? value.date ?? value.onsetDate;
  const effectiveDate = parseDocumentDate(own) ?? parseDocumentDate(await documentDate(tx, f.processingId));
  const record = await tx.patientProvidedRecord.create({
    data: { personId: f.personId, kind, value: value as Prisma.InputJsonValue, factId: f.id, documentId, pageNo: f.pageNo, region: (f.region ?? undefined) as Prisma.InputJsonValue | undefined, handwritten: f.handwritten, effectiveDate },
  });
  const r = await tx.extractedFact.updateMany({ where: { id: f.id, recordEntryId: null }, data: { recordEntryId: record.id } });
  if (r.count !== 1) throw new Error("A fact was merged twice.");
  await tx.documentProcessingStep.updateMany({ where: { processingId: f.processingId, step: "MERGE", status: "PENDING" }, data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 }, version: { increment: 1 } } });
  await emitDomainEvent(tx, { type: "PatientProvidedRecordAdded", aggregateId: record.id, personId: f.personId, payload: { recordId: record.id, personId: f.personId, kind, factId: f.id, documentId } });
  // A re-run of the same document confirming the same entry supersedes the old one (its bridged allergies move over).
  const same = JSON.stringify(value, Object.keys(value).sort());
  for (const old of await tx.patientProvidedRecord.findMany({ where: { documentId, kind, status: "ACTIVE", id: { not: record.id } } })) {
    const ov = old.value as Record<string, unknown>;
    if (JSON.stringify(ov, Object.keys(ov).sort()) !== same) continue;
    await tx.patientProvidedRecord.update({ where: { id: old.id }, data: { status: "SUPERSEDED", version: { increment: 1 } } });
    await tx.allergy.updateMany({ where: { patientProvidedRecordId: old.id }, data: { patientProvidedRecordId: record.id } });
    await emitDomainEvent(tx, { type: "PatientProvidedRecordUpdated", aggregateId: old.id, personId: f.personId, payload: { recordId: old.id, personId: f.personId, kind, change: "SUPERSEDED" } });
  }
  await bridgeAllergy(tx, record);
}

/** When no fact of the run is PENDING, the run is COMPLETED. */
async function completeIfReviewed(tx: Tx, processingId: string, personId: string, documentId: string) {
  const pending = await tx.extractedFact.count({ where: { processingId, reviewStatus: "PENDING" } });
  if (pending > 0) return;
  const run = await tx.documentProcessing.findUniqueOrThrow({ where: { id: processingId }, select: { status: true } });
  if (run.status !== "AWAITING_REVIEW") return;
  // Every decided fact is in the record before the run completes, whatever order the events come in.
  for (const f of await tx.extractedFact.findMany({ where: { processingId, reviewStatus: { in: ["CONFIRMED", "CORRECTED"] }, recordEntryId: null } })) await mergeOne(tx, f, documentId);
  const by = await tx.extractedFact.groupBy({ by: ["reviewStatus"], where: { processingId }, _count: true });
  const n = (s: string) => by.find((b) => b.reviewStatus === s)?._count ?? 0;
  await tx.documentProcessingStep.updateMany({ where: { processingId, step: "MERGE", status: { in: ["PENDING", "RUNNING"] } }, data: { status: "DONE", finishedAt: new Date(), provider: "aarogya", version: { increment: 1 } } });
  await moveRun(tx, processingId, "COMPLETED");
  await emitDomainEvent(tx, { type: "DocumentProcessingCompleted", aggregateId: processingId, personId, payload: { processingId, documentId, personId, confirmed: n("CONFIRMED"), corrected: n("CORRECTED"), rejected: n("REJECTED") } });
}

/** The person withdraws one of their record entries; bridged allergies follow. */
export async function withdrawPatientRecord(userId: string, recordId: string) {
  const personId = await requireOwnedPerson(userId);
  const out = await prisma.$transaction(async (tx) => {
    const rec = await tx.patientProvidedRecord.findUnique({ where: { id: recordId } });
    if (!rec || rec.personId !== personId) throw new NotFoundError();
    if (rec.status !== "ACTIVE") return { status: rec.status, allergiesWithdrawn: 0 };
    return { status: "WITHDRAWN" as const, allergiesWithdrawn: await withdrawRecord(tx, rec) };
  });
  await recordAuditEvent("person.record.withdrawn", userId, { personId, recordId });
  return out;
}

async function withdrawRecord(tx: Tx, rec: PatientProvidedRecord) {
  const r = await tx.patientProvidedRecord.updateMany({ where: { id: rec.id, status: "ACTIVE" }, data: { status: "WITHDRAWN", withdrawnAt: new Date(), version: { increment: 1 } } });
  if (r.count !== 1) return 0;
  await tx.recordConflict.deleteMany({ where: { patientProvidedRecordId: rec.id, status: { not: "RESOLVED_BY_CLINICIAN" } } });
  await emitDomainEvent(tx, { type: "PatientProvidedRecordUpdated", aggregateId: rec.id, personId: rec.personId, payload: { recordId: rec.id, personId: rec.personId, kind: rec.kind, change: "WITHDRAWN" } });
  return withdrawAllergyBridges(tx, rec.personId, { patientProvidedRecordId: rec.id });
}

/**
 * doc-withdrawal: the person withdrew the upload. Its open run is CANCELLED,
 * PENDING facts are discarded, and entries already merged are withdrawn
 * (with their bridged allergies).
 */
export async function withdrawDocumentDerived(documentId: string) {
  await prisma.$transaction(async (tx) => {
    const runs = await tx.documentProcessing.findMany({ where: { documentId } });
    for (const run of runs) {
      if (["QUEUED", "RUNNING", "AWAITING_REVIEW"].includes(run.status)) {
        await moveRun(tx, run.id, "CANCELLED");
        await tx.documentProcessingStep.updateMany({ where: { processingId: run.id, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "SKIPPED", finishedAt: new Date(), version: { increment: 1 } } });
      }
      await tx.extractedFact.deleteMany({ where: { processingId: run.id, reviewStatus: "PENDING" } });
    }
    for (const rec of await tx.patientProvidedRecord.findMany({ where: { documentId, status: "ACTIVE" } })) await withdrawRecord(tx, rec);
  });
}

/** doc-allergy-bridge: sharing granted or declined, a link made or ended. */
export async function rebridgePerson(personId: string, change: { patientId?: string; ended?: boolean }) {
  await prisma.$transaction(async (tx) => {
    if (change.ended && change.patientId) return void (await withdrawAllergyBridges(tx, personId, { patientId: change.patientId }));
    const person = await tx.person.findUnique({ where: { id: personId }, select: { status: true } });
    // A closed (or merged-away) account shares nothing: its bridges are taken back.
    if (person?.status === "ACTIVE" && (await personDecision(personId, SHARE_UPLOADS)) === "GRANTED") {
      for (const rec of await tx.patientProvidedRecord.findMany({ where: { personId, kind: "ALLERGY", status: "ACTIVE" } })) await bridgeAllergy(tx, rec);
    } else {
      await withdrawAllergyBridges(tx, personId, {});
    }
  });
}

// ── Who sees the entries (§3, Person design §8.3) ───────────────────────────

/** The person's own entries: always visible to them. */
export async function listOwnRecords(userId: string) {
  const personId = await requireOwnedPerson(userId);
  return prisma.patientProvidedRecord.findMany({ where: { personId, status: "ACTIVE" }, orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }] });
}

/**
 * The entries staff of `facilityId` may see for these records: only where the
 * person shares uploads with hospitals treating them (affirmative; no
 * default) and the facility has a care relationship (personAccess). Always
 * labelled PATIENT_PROVIDED.
 */
export async function staffPatientProvidedRecords(facilityId: string, patientIds: string[]) {
  const links = await prisma.personPatientLink.findMany({ where: { patientId: { in: patientIds }, facilityId, status: "ACTIVE" }, select: { personId: true } });
  const out: PatientProvidedRecord[] = [];
  for (const personId of [...new Set(links.map((l) => l.personId))]) {
    if ((await personDecision(personId, SHARE_UPLOADS)) !== "GRANTED") continue;
    if (!(await personAccess({ kind: "STAFF", userId: "", facilityId }, personId, "UPLOADS"))) continue;
    out.push(...(await prisma.patientProvidedRecord.findMany({ where: { personId, status: "ACTIVE" }, orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }] })));
  }
  return out;
}
