/**
 * Week 4b, RAG step 6 — the rag-indexer and backfill (docs/RAG_DESIGN.md §5),
 * through the real dispatcher on the mock embeddings:
 *   - each source becomes one document per version, chunked and embedded in
 *     the active space and every space being built; the Person is set on a
 *     linked record's documents;
 *   - replay creates nothing; an amendment (note, lab result) supersedes the
 *     old document (no chunks left); a change in place (a diagnosis resolved)
 *     is a new version; entered in error is withdrawn;
 *   - vitals are one document per encounter-day; allergies and the allergy
 *     status, referrals, person documents (title only) are indexed;
 *   - an unconfirmed extracted fact is never indexed; a confirmed one is, as
 *     PATIENT_PROVIDED, UPLOADS plus its own category;
 *   - an unlink clears the Person; AI consent declined removes everything
 *     and later events are skipped; granted again, it is re-indexed;
 *   - a REAL facility is skipped with the switch off, and its backfill
 *     refused; the backfill matches consumption;
 *   - closing an account removes the Person's own documents; reopening
 *     brings them back;
 *   - a consent decided before an 18th birthday lapses (PersonConsentLapsed);
 *     the AI refuses while lapsed; the index is kept, then removed after 90
 *     days;
 *   - a family member's revoked access purges the text kept of their AI
 *     questions.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-rag-indexer.ts
 */
import { prisma } from "../src/lib/db";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { emitFacilityEvent } from "../src/lib/events/facilityEvent";
import { ragIndexer } from "../src/lib/consumers/ragIndexer";
import { amendNote, createNote } from "../src/lib/hospital/clinicalNote";
import { recordAllergy, recordDiagnosis, recordVitals, updateDiagnosis } from "../src/lib/hospital/clinicalRecords";
import { createReferral } from "../src/lib/hospital/referral";
import { decidePersonConsent } from "../src/lib/person/consent";
import { closePersonAccount, reopenPersonAccount } from "../src/lib/person/closure";
import { unlinkByPerson } from "../src/lib/person/linking";
import { uploadPersonDocument } from "../src/lib/person/documents";
import { fixtureById, fixturePdf } from "../src/lib/documents/fixtures";
import { setDocumentProvidersForTest } from "../src/lib/ai/documents";
import { bulkReview, listOwnFacts } from "../src/lib/documents/review";
import { mayUseAiOver } from "../src/lib/ai/realData";
import { sweepConsentLapses } from "../src/lib/person/consentLapse";
import { purgeLapsedAiIndexes, sourcesOfPatient } from "../src/lib/rag/indexer";
import { backfillFacility } from "../src/lib/rag/backfill";
import { removeOwnerIndex } from "../src/lib/rag/remove";
import { activeSpace } from "../src/lib/rag/embed";
import { startReembed } from "../src/lib/rag/reembed";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refused = <T>(p: Promise<T>) => p.then(() => false, () => true);
const tag = Date.now().toString(36);
let seq = 0;
let clock = Date.now();

async function drain() {
  for (let i = 0; i < 40; i++) {
    clock += 2 * 3_600_000;
    const r = await dispatchPendingDomainEvents({ now: new Date(clock), batchSize: 500, maxDurationMs: 60_000 });
    if (r.claimed === 0) return;
  }
}

async function person(opts: { dob?: Date } = {}) {
  seq += 1;
  const a = await registerPatientAccount({ fullName: `Indexer ${tag} ${seq}`, email: `rag-indexer-${tag}-${seq}@verify.aarogya`, passwordHash: "x", sex: "F", dob: opts.dob ?? new Date("1975-03-03") });
  if (a.status !== "LINKED_NEW") throw new Error("fixture person");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC", ...(opts.dob ? { dateOfBirth: opts.dob } : {}) } });
  const link = await prisma.personPatientLink.findFirstOrThrow({ where: { personId, status: "ACTIVE" }, include: { patient: { select: { facilityId: true } } } });
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { department: { facilityId: link.patient.facilityId } }, select: { id: true, userId: true } });
  const enc = await prisma.encounter.create({ data: { patientId: link.patientId, facilityId: link.patient.facilityId, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "indexer gate" } });
  return { userId: a.userId, personId, patientId: link.patientId, facilityId: link.patient.facilityId, linkId: link.id, staff, encounterId: enc.id };
}

const docsOf = (sourceId: string) => prisma.ragDocument.findMany({ where: { sourceId }, orderBy: { sourceVersion: "asc" }, include: { chunks: { include: { embeddings: { select: { embeddingModel: true, embeddingVersion: true } } } } } });
const activeOf = async (where: object) => prisma.ragDocument.count({ where: { ...where, status: "ACTIVE" } });

async function note(p: Awaited<ReturnType<typeof person>>, text: string) {
  return createNote({ encounterId: p.encounterId, authorStaffId: p.staff.id, authorRole: "DOCTOR", type: "PROGRESS", content: { subjective: text, plan: "Review in two weeks." }, sign: true, byUserId: p.staff.userId });
}

async function main() {
  registerAllConsumers();
  setDocumentProvidersForTest(null);
  const space = await activeSpace();
  const building = await startReembed({ embeddingModel: "mock-hash-256", embeddingVersion: 1, provider: "mock", dims: 256 });
  const p = await person();

  // 1. A signed note.
  const n1 = await note(p, "Cough and fever for three days; on paracetamol.");
  await drain();
  const d1 = await docsOf(n1.id);
  report("A signed note: one ACTIVE document, chunked, for the care team only (STAFF_ONLY), CLINICAL_NOTES",
    d1.length === 1 && d1[0].status === "ACTIVE" && d1[0].chunks.length >= 1 && d1[0].audience === "STAFF_ONLY" && d1[0].categories.join() === "CLINICAL_NOTES" && !!d1[0].indexedFromEventId);
  report("…embedded in the active space and in the space being built", d1[0].chunks.every((c) => c.embeddings.some((e) => e.embeddingModel === space.embeddingModel && e.embeddingVersion === space.embeddingVersion) && c.embeddings.some((e) => e.embeddingModel === "mock-hash-256")));
  report("…owned by the facility record, carrying the linked Person", d1[0].ownerType === "FACILITY_PATIENT" && d1[0].facilityId === p.facilityId && d1[0].patientId === p.patientId && d1[0].personId === p.personId
    && d1[0].chunks.every((c) => c.personId === p.personId && c.facilityId === p.facilityId));
  const ev = await prisma.domainEventOutbox.findFirstOrThrow({ where: { aggregateId: n1.id, eventType: "ClinicalNoteSigned" } });
  const envelope = { eventId: ev.eventId, eventType: ev.eventType, eventVersion: ev.eventVersion, aggregateType: ev.aggregateType, aggregateId: ev.aggregateId, organizationId: ev.organizationId, facilityId: ev.facilityId, personId: ev.personId, actorUserId: ev.actorUserId, correlationId: ev.correlationId, causationId: ev.causationId, occurredAt: ev.occurredAt, payload: ev.payload as Record<string, unknown> } as unknown as Parameters<typeof ragIndexer.handle>[0];
  const before = await prisma.ragChunk.count();
  await ragIndexer.handle(envelope);
  await ragIndexer.handle(envelope);
  report("Replay creates nothing (same version, same content)", (await docsOf(n1.id)).length === 1 && (await prisma.ragChunk.count()) === before);

  // 2. An amended note.
  const n2 = await amendNote({ supersedesId: n1.id, encounterId: p.encounterId, authorStaffId: p.staff.id, authorRole: "DOCTOR", type: "PROGRESS", content: { subjective: "Cough and fever for four days; on paracetamol." }, amendmentReason: "duration", byUserId: p.staff.userId });
  await drain();
  const [old] = await docsOf(n1.id);
  report("An amendment supersedes: the old note's document SUPERSEDED with no chunks, the new one ACTIVE (amended)",
    old.status === "SUPERSEDED" && old.chunks.length === 0 && (await docsOf(n2.id))[0]?.status === "ACTIVE" && (await docsOf(n2.id))[0].title.includes("amended"));

  // 3. A lab result, released then amended.
  const order = await prisma.labOrder.create({ data: { encounterId: p.encounterId, patientId: p.patientId, testName: "Hemoglobin", category: "Hematology", orderedByStaffId: p.staff.id } });
  const r1 = await prisma.labResult.create({ data: { labOrderId: order.id, value: "11.2", unit: "g/dL", referenceRange: "12.0 - 15.5", abnormalFlag: "LOW", status: "VERIFIED", resultedAt: new Date("2026-10-10T08:00:00Z") } });
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LabResultReleased", aggregateId: r1.id, facilityId: p.facilityId, payload: { resultId: r1.id, orderId: order.id, patientId: p.patientId } }));
  await drain();
  report("A released lab result: one sentence with value, unit, range and flag (LABS, patient-visible)",
    (await docsOf(r1.id))[0]?.chunks[0]?.text === "Hemoglobin 11.2 g/dL (reference 12.0 - 15.5), low, resulted 2026-10-10." && (await docsOf(r1.id))[0].audience === "PATIENT_VISIBLE");
  await prisma.labResult.update({ where: { id: r1.id }, data: { isCurrent: false, status: "SUPERSEDED" } });
  const r2 = await prisma.labResult.create({ data: { labOrderId: order.id, value: "11.8", unit: "g/dL", referenceRange: "12.0 - 15.5", abnormalFlag: "LOW", status: "AMENDED", version: 2, previousVersionId: r1.id, resultedAt: new Date("2026-10-10T08:00:00Z") } });
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "DiagnosticReportAmended", aggregateId: r2.id, aggregateType: "LAB_RESULT", facilityId: p.facilityId, payload: { reportKind: "LAB", amendedId: r2.id, supersedesId: r1.id, orderId: order.id, patientId: p.patientId, version: 2, critical: false } }));
  await drain();
  report("Its amendment supersedes it: only 11.8 is ACTIVE", (await docsOf(r1.id))[0].status === "SUPERSEDED" && (await docsOf(r2.id))[0]?.chunks[0]?.text.includes("11.8 g/dL") && (await activeOf({ sourceId: { in: [r1.id, r2.id] } })) === 1);

  // 4. Diagnoses: a change in place is a new version; entered in error is withdrawn.
  const dx = await recordDiagnosis({ encounterId: p.encounterId, facilityId: p.facilityId, staffId: p.staff.id, diagnosis: "Community acquired pneumonia", type: "PROVISIONAL", code: "J18.9", codeSystem: "ICD-10", byUserId: p.staff.userId });
  await drain();
  await updateDiagnosis({ diagnosisId: dx.id, facilityId: p.facilityId, status: "RESOLVED", byUserId: p.staff.userId });
  await drain();
  const dxs = await docsOf(dx.id);
  report("A diagnosis resolved in place is version 2 (the first SUPERSEDED)", dxs.length === 2 && dxs[0].status === "SUPERSEDED" && dxs[1].status === "ACTIVE" && dxs[1].sourceVersion === 2 && dxs[1].chunks[0].text.includes("resolved"));
  const dx2 = await recordDiagnosis({ encounterId: p.encounterId, facilityId: p.facilityId, staffId: p.staff.id, diagnosis: "Asthma", type: "PROVISIONAL", byUserId: p.staff.userId });
  await drain();
  await updateDiagnosis({ diagnosisId: dx2.id, facilityId: p.facilityId, status: "ENTERED_IN_ERROR", byUserId: p.staff.userId });
  await drain();
  const w = (await docsOf(dx2.id))[0];
  report("Entered in error: WITHDRAWN (SOURCE_DELETED), its chunks deleted", w?.status === "WITHDRAWN" && w.withdrawnReason === "SOURCE_DELETED" && w.chunks.length === 0);

  // 5. Allergies, the allergy status, vitals, a referral.
  const al = await recordAllergy({ patientId: p.patientId, facilityId: p.facilityId, substance: "Penicillin", reaction: "rash", severity: "severe", byUserId: p.staff.userId });
  await drain();
  report("An allergy and the allergy status (HAS_ALLERGIES, its version the history's sequence) are indexed (ALLERGIES)",
    (await docsOf(al.id))[0]?.categories.join() === "ALLERGIES" && (await prisma.ragDocument.findFirst({ where: { sourceType: "ALLERGY_STATUS", sourceId: p.patientId, status: "ACTIVE" } }))?.title.startsWith("Has allergies") === true);
  await recordVitals({ encounterId: p.encounterId, facilityId: p.facilityId, staffId: p.staff.id, vitals: { hr: 108, sbp: 142, dbp: 90, spo2: 94, tempC: 38.2 }, byUserId: p.staff.userId });
  await drain();
  await recordVitals({ encounterId: p.encounterId, facilityId: p.facilityId, staffId: p.staff.id, vitals: { hr: 96, spo2: 96, tempC: 37.6 }, byUserId: p.staff.userId });
  await drain();
  const vit = await prisma.ragDocument.findMany({ where: { sourceType: "OBSERVATION", patientId: p.patientId, status: "ACTIVE" }, include: { chunks: true } });
  report("Vitals are one document per encounter-day, both readings in it (VITALS)", vit.length === 1 && (vit[0].chunks[0].text.match(/Vitals at/g) ?? []).length === 2 && vit[0].sourceVersion === 2);
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: p.facilityId }, select: { id: true } });
  const ref = await createReferral({ encounterId: p.encounterId, facilityId: p.facilityId, fromStaffId: p.staff.id, toDepartmentId: dept.id, reason: "Persistent wheeze", priority: "URGENT", byUserId: p.staff.userId });
  await drain();
  report("A referral is indexed (REFERRALS)", (await docsOf((ref as { id: string }).id))[0]?.categories.join() === "REFERRALS");

  // 6. Uploads: unconfirmed facts are never indexed; confirmed ones are, as the Person's.
  const up = await uploadPersonDocument(p.userId, { bytes: await fixturePdf(fixtureById("lab-hi-kft")!), contentType: "application/pdf", originalName: "kft.pdf", title: "KFT 2026", type: "REPORT" });
  await drain();
  const pdoc = (await docsOf(up.id))[0];
  report("An upload is indexed by title and date only, as the Person's (PATIENT_PROVIDED, UPLOADS)", pdoc?.ownerType === "PERSON" && pdoc.personId === p.personId && pdoc.facilityId === null && pdoc.origin === "PATIENT_PROVIDED" && pdoc.chunks[0].text.includes("not confirmed yet") && !pdoc.chunks[0].text.includes("1.42"));
  report("Facts awaiting review are never indexed", (await prisma.ragDocument.count({ where: { personId: p.personId, sourceType: "PATIENT_PROVIDED_RECORD" } })) === 0 && (await prisma.ragChunk.count({ where: { personId: p.personId, text: { contains: "1.42" } } })) === 0);
  const facts = await listOwnFacts(p.userId);
  await bulkReview(p.userId, { decisions: facts.map((f) => ({ factId: f.id, version: f.version, decision: "CONFIRM" })) });
  await drain();
  const pp = await prisma.ragDocument.findMany({ where: { personId: p.personId, sourceType: "PATIENT_PROVIDED_RECORD", status: "ACTIVE" }, include: { chunks: true } });
  report("Confirmed facts are indexed: PERSON-owned, PATIENT_PROVIDED, UPLOADS and their own category, values exact",
    pp.length >= 4 && pp.every((d) => d.ownerType === "PERSON" && d.origin === "PATIENT_PROVIDED" && d.categories.includes("UPLOADS")) && pp.some((d) => d.categories.join() === "UPLOADS,LABS" && d.chunks[0].text.includes("Creatinine 1.42 mg/dL (reference 0.70 - 1.30), high")));

  // 7. Unlink: the facility's documents lose the Person; nothing is deleted.
  const facilityDocs = await activeOf({ patientId: p.patientId });
  const q = await person();
  await note(q, "Knee pain on climbing stairs.");
  await drain();
  await unlinkByPerson(q.userId, q.linkId);
  await drain();
  report("An unlink clears the Person on the record's documents, chunks and embeddings; nothing deleted",
    (await prisma.ragDocument.count({ where: { patientId: q.patientId, personId: { not: null } } })) === 0 && (await prisma.ragChunk.count({ where: { patientId: q.patientId, personId: { not: null } } })) === 0
      && (await prisma.ragEmbedding.count({ where: { patientId: q.patientId, personId: { not: null } } })) === 0 && (await activeOf({ patientId: q.patientId })) >= 1);

  // 8. AI consent declined: everything goes, later events are skipped; granted again, it all comes back.
  await decidePersonConsent({ userId: p.userId, purpose: "AI_ASSISTANCE", decision: "DECLINED" });
  await drain();
  report("AI consent declined removes the Person's whole index (their own and their linked record's)",
    (await prisma.ragDocument.count({ where: { OR: [{ personId: p.personId }, { patientId: p.patientId }] } })) === 0 && (await prisma.ragEmbedding.count({ where: { OR: [{ personId: p.personId }, { patientId: p.patientId }] } })) === 0);
  const n3 = await note(p, "Breathing easier today.");
  await drain();
  report("…and a later event is skipped (nothing indexed while declined)", (await docsOf(n3.id)).length === 0);
  report("The AI gate refuses the declined Person's record, though synthetic", (await mayUseAiOver({ facilityId: p.facilityId, patientId: p.patientId })).allowed === false);
  await decidePersonConsent({ userId: p.userId, purpose: "AI_ASSISTANCE", decision: "GRANTED" });
  await drain();
  report("Granted again: re-indexed, the later note included", (await activeOf({ patientId: p.patientId })) === facilityDocs + 1 && (await docsOf(n3.id)).some((d) => d.status === "ACTIVE")
    && (await activeOf({ personId: p.personId, ownerType: "PERSON" })) === pp.length + 1);

  // 9. Backfill matches consumption.
  const snapshot = async () => (await prisma.ragDocument.findMany({ where: { patientId: p.patientId, status: "ACTIVE" }, select: { sourceType: true, sourceId: true, contentHash: true } })).map((d) => `${d.sourceType}:${d.sourceId}:${d.contentHash}`).sort().join("\n");
  const consumed = await snapshot();
  await removeOwnerIndex(prisma, { facilityId: p.facilityId, patientId: p.patientId });
  const bf = await backfillFacility({ facilityId: p.facilityId, restart: true, batchSize: 200 });
  report("The backfill (the indexer's own function, resumable cursors) rebuilds exactly what consumption built", (await snapshot()) === consumed && bf.indexed >= 1, `seen ${bf.seen}, indexed ${bf.indexed}`);
  const again = await backfillFacility({ facilityId: p.facilityId, batchSize: 200 });
  report("Resumed, it has nothing left to do (the cursors are at the end)", again.seen === 0);
  report("Every source of the record is reachable for a backfill", (await sourcesOfPatient(p.patientId)).length >= consumed.split("\n").length);

  // 10. A REAL facility: skipped with the switch off; its backfill refused.
  const org = await prisma.facility.findUniqueOrThrow({ where: { id: p.facilityId }, select: { organizationId: true } });
  const realFac = await prisma.facility.create({ data: { id: `fac-real-${tag}`, name: `Real ${tag}`, city: "Pune", organizationId: org.organizationId } });
  const realPat = await prisma.patient.create({ data: { uhid: `REAL-${tag}`, facilityId: realFac.id, fullName: "Real Patient", sex: "M" } });
  const realEnc = await prisma.encounter.create({ data: { patientId: realPat.id, facilityId: realFac.id, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "x" } });
  const realNote = await prisma.clinicalNote.create({ data: { encounterId: realEnc.id, authorStaffId: p.staff.id, authorRole: "DOCTOR", type: "PROGRESS", content: { s: "real" }, status: "SIGNED", signedAt: new Date() } });
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "ClinicalNoteSigned", aggregateId: realNote.id, facilityId: realFac.id, encounterId: realEnc.id, payload: { entryId: realNote.id, encounterId: realEnc.id, patientId: realPat.id, entryType: "PROGRESS" } }));
  await drain();
  report("A REAL facility's event is delivered and skipped: nothing indexed (switch off)", (await prisma.ragDocument.count({ where: { facilityId: realFac.id } })) === 0
    && (await prisma.domainEventDelivery.count({ where: { consumerName: "rag-indexer", status: "PROCESSED", event: { aggregateId: realNote.id } } })) === 1);
  report("…and its backfill is refused", await refused(backfillFacility({ facilityId: realFac.id })));

  // 11. Closing the account removes the Person's own documents; reopening brings them back.
  await closePersonAccount(p.userId, "CLOSE");
  await drain();
  report("Closing the account removes the Person's own documents", (await prisma.ragDocument.count({ where: { personId: p.personId, ownerType: "PERSON" } })) === 0);
  await reopenPersonAccount(p.userId);
  await drain();
  report("Reopening re-indexes them", (await activeOf({ personId: p.personId, ownerType: "PERSON" })) === pp.length + 1);

  // 12. A consent decided before the 18th birthday lapses on it.
  const dob = new Date(Date.now() - (18 * 365.25 - 30) * 86_400_000);
  const m = await person({ dob });
  await decidePersonConsent({ userId: m.userId, purpose: "AI_ASSISTANCE", decision: "GRANTED" });
  await note(m, "Sore throat.");
  await drain();
  const indexed = await activeOf({ patientId: m.patientId });
  await sweepConsentLapses();
  report("No lapse before the 18th birthday", (await prisma.personConsent.count({ where: { personId: m.personId, status: "LAPSED" } })) === 0);
  const later = new Date(Date.now() + 60 * 86_400_000);
  await sweepConsentLapses({ now: later });
  const lapsed = await prisma.personConsent.findFirst({ where: { personId: m.personId, purpose: "AI_ASSISTANCE" }, orderBy: { decidedAt: "desc" } });
  report("On it, the consent lapses (LAPSED, when), announced as PersonConsentLapsed (no values)", lapsed?.status === "LAPSED" && !!lapsed.lapsedAt
    && (await prisma.domainEventOutbox.count({ where: { eventType: "PersonConsentLapsed", personId: m.personId } })) >= 1);
  const gate = await mayUseAiOver({ facilityId: m.facilityId, patientId: m.patientId });
  report("While lapsed, the AI refuses (as not granted), though the data is synthetic", !gate.allowed && gate.reason === "AI_CONSENT_LAPSED");
  await purgeLapsedAiIndexes({ now: new Date(later.getTime() + 30 * 86_400_000) });
  report("The index is kept within the 90-day window", indexed >= 1 && (await activeOf({ patientId: m.patientId })) === indexed);
  await purgeLapsedAiIndexes({ now: new Date(later.getTime() + 91 * 86_400_000) });
  report("…and removed after it", (await prisma.ragDocument.count({ where: { patientId: m.patientId } })) === 0);

  // 13. A family member's access revoked: the text kept of their AI questions goes.
  const kept = await prisma.aiInteraction.create({ data: { userId: "proxy", role: "PATIENT", patientId: q.patientId, proxyGrantId: `deleg-${tag}`, mode: "EXPLAIN_REPORT", language: "en", model: "mock", embeddingModel: "m", embeddingVersion: 1, outcome: "ANSWERED", latencyMs: 1, metadataExpiresAt: new Date(Date.now() + 365 * 86_400_000), questionCiphertext: "c", answerCiphertext: "c", keyVersion: 1, textScope: "PATIENT_OPT_IN", textExpiresAt: new Date(Date.now() + 86_400_000) } });
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "FamilyAccessRevoked", aggregateId: `deleg-${tag}`, facilityId: q.facilityId, payload: { delegationId: `deleg-${tag}`, patientId: q.patientId, delegateUserId: "proxy", reason: "REVOKED" } }));
  await drain();
  const after = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: kept.id } });
  report("Family access revoked: that member's retained AI text is purged, the metadata stays", after.questionCiphertext === null && after.answerCiphertext === null && after.textScope === null && after.outcome === "ANSWERED");

  // Clean up the space being built (later gates see only the active one).
  await prisma.ragEmbedding.deleteMany({ where: { embeddingModel: building.embeddingModel } });
  await prisma.ragEmbeddingSpace.delete({ where: { id: building.id } });

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
