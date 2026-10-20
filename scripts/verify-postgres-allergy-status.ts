/**
 * Week 4b (4a follow-up b) — the record-level allergy status
 * (NO_KNOWN_ALLERGIES | UNKNOWN | HAS_ALLERGIES), its history and its event,
 * the prescribing check's caution, and the pipeline's "no known allergies"
 * conflict rule (docs/DOCUMENT_PIPELINE_DESIGN.md §8.1):
 *   - no entry reads as UNKNOWN, and the prescribing check flags it (a
 *     warning, never read as "no allergies");
 *   - recording a status appends one entry and emits AllergyStatusRecorded in
 *     the same transaction; recording the same status again changes nothing;
 *   - recording an allergy makes the status HAS_ALLERGIES; inactivating the
 *     last one makes it UNKNOWN, never NO_KNOWN_ALLERGIES;
 *   - "no known allergies" (and UNKNOWN) are refused while an allergy is
 *     active; HAS_ALLERGIES is refused without one;
 *   - history is append-only, in order, under concurrency; another facility
 *     gets a 404;
 *   - an uploaded, confirmed allergy conflicts with a "no known allergies"
 *     recorded after the document's date (either order, through the events),
 *     not with one recorded before; the verified status is shown first.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-allergy-status.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { fixtureById, fixturePdf } from "../src/lib/documents/fixtures";
import { setDocumentProvidersForTest } from "../src/lib/ai/documents";
import { uploadPersonDocument } from "../src/lib/person/documents";
import { bulkReview, listOwnFacts } from "../src/lib/documents/review";
import { listOwnConflicts } from "../src/lib/documents/conflicts";
import { decidePersonConsent } from "../src/lib/person/consent";
import { checkMedicationSafety } from "../src/lib/hospital/clinicalSafety";
import { allergyStatusHistory, currentAllergyStatus, recordAllergy, recordAllergyStatus, updateAllergy } from "../src/lib/hospital/clinicalRecords";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

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

/** A synthetic person with an ACTIVE link to a new facility record. */
async function person() {
  seq += 1;
  const a = await registerPatientAccount({ fullName: `Allergy Status ${tag} ${seq}`, email: `allergystatus-${tag}-${seq}@verify.aarogya`, passwordHash: "x", sex: "M", dob: new Date("1979-05-05") });
  if (a.status !== "LINKED_NEW") throw new Error("fixture person");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC", preferredLanguage: "en" } });
  const link = await prisma.personPatientLink.findFirstOrThrow({ where: { personId, status: "ACTIVE" }, include: { patient: { select: { facilityId: true } } } });
  return { userId: a.userId, personId, patientId: link.patientId, facilityId: link.patient.facilityId };
}

/** Key-order-independent JSON (payloads come back from JSONB with their keys reordered). */
const canon = (v: unknown) => JSON.stringify(Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))));
const refused = <T>(p: Promise<T>) => p.then(() => false, () => true);
const notFound = <T>(p: Promise<T>) => p.then(() => false, (e) => e?.constructor?.name === "NotFoundError");
const statusEvents = (patientId: string) => prisma.domainEventOutbox.findMany({ where: { aggregateId: patientId, eventType: "AllergyStatusRecorded" }, orderBy: { seq: "asc" } });

async function uploadAndConfirm(userId: string, fixtureId: string) {
  const d = await uploadPersonDocument(userId, { bytes: await fixturePdf(fixtureById(fixtureId)!), contentType: "application/pdf", originalName: "rx.pdf", title: "Prescription", type: "REPORT" });
  await drain();
  const run = await prisma.documentProcessing.findFirstOrThrow({ where: { documentId: d.id } });
  const facts = (await listOwnFacts(userId)).filter((f) => f.processingId === run.id);
  await bulkReview(userId, { decisions: facts.map((f) => ({ factId: f.id, version: f.version, decision: "CONFIRM" })) });
  await drain();
}

async function main() {
  registerAllConsumers();
  setDocumentProvidersForTest(null);
  const p = await person();
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { department: { facilityId: p.facilityId } }, select: { userId: true } });
  const by = staff.userId;
  const otherFacility = await prisma.facility.findFirstOrThrow({ where: { id: { not: p.facilityId } }, select: { id: true } });

  // 1. Nothing recorded: UNKNOWN, and the prescribing check says so.
  const s0 = await currentAllergyStatus(p.patientId);
  report("No entry and no allergy: UNKNOWN (derived), never 'no known allergies'", s0.status === "UNKNOWN" && s0.derived && s0.entryId === null);
  const f0 = await checkMedicationSafety(p.patientId, "Amoxicillin");
  report("The prescribing check flags the unknown status (a warning: it never blocks, never reads as 'none')",
    f0.some((f) => f.rule === "allergy-status-unknown" && f.severity === "warning") && !f0.some((f) => f.severity === "danger"));

  // 2. A clinician records "no known allergies".
  const r1 = await recordAllergyStatus({ patientId: p.patientId, facilityId: p.facilityId, status: "NO_KNOWN_ALLERGIES", byUserId: by });
  const e1 = await statusEvents(p.patientId);
  report("Recording NO_KNOWN_ALLERGIES: one entry (sequence 1, no previous), recorded",
    r1.changed && r1.status.status === "NO_KNOWN_ALLERGIES" && !r1.status.derived && (await prisma.allergyStatusEntry.count({ where: { patientId: p.patientId } })) === 1);
  report("…and AllergyStatusRecorded (RECORDED, previous null), facility-scoped, ids and codes only",
    e1.length === 1 && e1[0].facilityId === p.facilityId && canon(e1[0].payload) === canon({ entryId: r1.status.entryId, patientId: p.patientId, status: "NO_KNOWN_ALLERGIES", previousStatus: null, reason: "RECORDED" }));
  report("The prescribing check no longer flags the status", !(await checkMedicationSafety(p.patientId, "Amoxicillin")).some((f) => f.rule === "allergy-status-unknown"));
  const again = await recordAllergyStatus({ patientId: p.patientId, facilityId: p.facilityId, status: "NO_KNOWN_ALLERGIES", byUserId: by });
  report("Recording the same status again changes nothing and emits nothing", !again.changed && (await statusEvents(p.patientId)).length === 1);
  report("HAS_ALLERGIES can't be recorded without an allergy", await refused(recordAllergyStatus({ patientId: p.patientId, facilityId: p.facilityId, status: "HAS_ALLERGIES", byUserId: by })));
  report("An unknown status value is refused", await refused(recordAllergyStatus({ patientId: p.patientId, facilityId: p.facilityId, status: "NONE", byUserId: by })));

  // 3. An allergy is recorded: HAS_ALLERGIES.
  const allergy = await recordAllergy({ patientId: p.patientId, facilityId: p.facilityId, substance: "Penicillin", severity: "severe", byUserId: by });
  const s3 = await currentAllergyStatus(p.patientId);
  const e3 = (await statusEvents(p.patientId)).at(-1)?.payload as { status: string; previousStatus: string; reason: string } | undefined;
  report("Recording an allergy makes the status HAS_ALLERGIES (ALLERGY_ADDED, previous NO_KNOWN_ALLERGIES), in the same transaction",
    s3.status === "HAS_ALLERGIES" && e3?.status === "HAS_ALLERGIES" && e3.previousStatus === "NO_KNOWN_ALLERGIES" && e3.reason === "ALLERGY_ADDED");
  report("While it is active, 'no known allergies' and UNKNOWN are refused, and nothing changes",
    await refused(recordAllergyStatus({ patientId: p.patientId, facilityId: p.facilityId, status: "NO_KNOWN_ALLERGIES", byUserId: by }))
      && await refused(recordAllergyStatus({ patientId: p.patientId, facilityId: p.facilityId, status: "UNKNOWN", byUserId: by }))
      && (await currentAllergyStatus(p.patientId)).status === "HAS_ALLERGIES");
  const f3 = await checkMedicationSafety(p.patientId, "Penicillin");
  report("Prescribing the allergen: the allergy flag (danger), no status flag", f3.some((f) => f.rule === "allergy-conflict" && f.severity === "danger") && !f3.some((f) => f.rule === "allergy-status-unknown"));
  await recordAllergy({ patientId: p.patientId, facilityId: p.facilityId, substance: "Latex", severity: "mild", byUserId: by });
  report("A second allergy adds no entry (already HAS_ALLERGIES)", (await prisma.allergyStatusEntry.count({ where: { patientId: p.patientId } })) === 2);

  // 4. The allergies are inactivated: UNKNOWN, never "no known allergies".
  const latex = await prisma.allergy.findFirstOrThrow({ where: { patientId: p.patientId, substance: "Latex" } });
  await updateAllergy({ allergyId: latex.id, facilityId: p.facilityId, status: "INACTIVE", byUserId: by });
  report("Inactivating one of two: still HAS_ALLERGIES", (await currentAllergyStatus(p.patientId)).status === "HAS_ALLERGIES");
  await updateAllergy({ allergyId: allergy.id, facilityId: p.facilityId, status: "ENTERED_IN_ERROR", byUserId: by });
  const s4 = await currentAllergyStatus(p.patientId);
  const e4 = (await statusEvents(p.patientId)).at(-1)?.payload as { status: string; reason: string } | undefined;
  report("The last one entered in error: UNKNOWN (LAST_ALLERGY_INACTIVATED), never 'no known allergies'", s4.status === "UNKNOWN" && e4?.status === "UNKNOWN" && e4.reason === "LAST_ALLERGY_INACTIVATED");
  report("…and the prescribing check flags the unknown status again", (await checkMedicationSafety(p.patientId, "Amoxicillin")).some((f) => f.rule === "allergy-status-unknown"));

  // 5. History.
  const h = await allergyStatusHistory(p.patientId, p.facilityId);
  report("History, newest first: UNKNOWN ← HAS_ALLERGIES ← NO_KNOWN_ALLERGIES, each naming the one before",
    h.history.map((x) => x.status).join(",") === "UNKNOWN,HAS_ALLERGIES,NO_KNOWN_ALLERGIES" && h.history.every((x, i) => x.previousStatus === (h.history[i + 1]?.status ?? null)));
  report("History is append-only (update and delete refused by the database)",
    await refused(prisma.allergyStatusEntry.update({ where: { id: h.history[0].id }, data: { status: "NO_KNOWN_ALLERGIES" } }))
      && await refused(prisma.allergyStatusEntry.delete({ where: { id: h.history[0].id } })));
  report("An entry's facility must be its patient's (database check)",
    await refused(prisma.allergyStatusEntry.create({ data: { patientId: p.patientId, facilityId: otherFacility.id, status: "NO_KNOWN_ALLERGIES", previousStatus: "UNKNOWN", reason: "RECORDED", sequence: 99 } })));
  report("Another facility gets a 404, for reading and for recording",
    await notFound(allergyStatusHistory(p.patientId, otherFacility.id)) && await notFound(recordAllergyStatus({ patientId: p.patientId, facilityId: otherFacility.id, status: "NO_KNOWN_ALLERGIES", byUserId: by })));

  // 6. Concurrency: alternating writes keep one unbroken, ordered history.
  const q = await person();
  await Promise.all(Array.from({ length: 8 }, (_, i) => recordAllergyStatus({ patientId: q.patientId, facilityId: q.facilityId, status: i % 2 ? "UNKNOWN" : "NO_KNOWN_ALLERGIES", byUserId: by }).catch(() => null)));
  const qh = await prisma.allergyStatusEntry.findMany({ where: { patientId: q.patientId }, orderBy: { sequence: "asc" } });
  report("Concurrent writes: sequences 1..n with no gap, each a real change from the one before",
    qh.length >= 1 && qh.every((x, i) => x.sequence === i + 1 && x.previousStatus === (qh[i - 1]?.status ?? null) && x.status !== x.previousStatus)
      && (await statusEvents(q.patientId)).length === qh.length, `${qh.length} entries`);

  // 7. The "no known allergies" conflict rule (pipeline §8.1).
  // a) Recorded first; the upload (dated 03/02/2026, an Aspirin allergy) is confirmed after.
  const a = await person();
  await recordAllergyStatus({ patientId: a.patientId, facilityId: a.facilityId, status: "NO_KNOWN_ALLERGIES", byUserId: by });
  await uploadAndConfirm(a.userId, "rx-en-2");
  const ca = await prisma.recordConflict.findMany({ where: { personId: a.personId, kind: "ALLERGY" } });
  const nkda = await prisma.allergyStatusEntry.findFirstOrThrow({ where: { patientId: a.patientId, status: "NO_KNOWN_ALLERGIES" } });
  report("'No known allergies' recorded after the document's date conflicts with the uploaded allergy (one conflict)",
    ca.length === 1 && ca[0].verifiedSourceType === "AllergyStatusEntry" && ca[0].verifiedSourceId === nkda.id && ca[0].patientId === a.patientId);
  const ev = await prisma.domainEventOutbox.findFirst({ where: { aggregateId: ca[0]?.id, eventType: "RecordConflictDetected" } });
  report("…announced as RecordConflictDetected v2, no substance in the payload", ev?.eventVersion === 2 && (ev.payload as { verifiedSourceType: string }).verifiedSourceType === "AllergyStatusEntry" && !JSON.stringify(ev.payload).includes("Aspirin"));
  const shown = (await listOwnConflicts(a.userId)).find((c) => c.kind === "ALLERGY");
  report("The person sees it with the verified status first, then 'Your uploaded report says …'",
    !!shown && Object.keys(shown).indexOf("verified") < Object.keys(shown).indexOf("patientProvided") && (shown.verified.value as { allergyStatus?: string })?.allergyStatus === "NO_KNOWN_ALLERGIES"
      && (shown.patientProvided?.value as { substance?: string })?.substance === "Aspirin");
  report("Nothing is overwritten: the status stays NO_KNOWN_ALLERGIES (no opt-in, so nothing was bridged)", (await currentAllergyStatus(a.patientId)).status === "NO_KNOWN_ALLERGIES" && (await prisma.allergy.count({ where: { patientId: a.patientId } })) === 0);

  // b) Uploaded first; "no known allergies" recorded after, through its event.
  const b = await person();
  await uploadAndConfirm(b.userId, "rx-en-2");
  report("Before any status: no allergy conflict", (await prisma.recordConflict.count({ where: { personId: b.personId, kind: "ALLERGY" } })) === 0);
  await recordAllergyStatus({ patientId: b.patientId, facilityId: b.facilityId, status: "NO_KNOWN_ALLERGIES", byUserId: by });
  await drain();
  report("'No known allergies' recorded later is checked through AllergyStatusRecorded: one conflict", (await prisma.recordConflict.count({ where: { personId: b.personId, kind: "ALLERGY", verifiedSourceType: "AllergyStatusEntry" } })) === 1);
  await recordAllergyStatus({ patientId: b.patientId, facilityId: b.facilityId, status: "UNKNOWN", byUserId: by });
  await drain();
  report("An UNKNOWN status raises no new conflict", (await prisma.recordConflict.count({ where: { personId: b.personId, kind: "ALLERGY" } })) === 1);

  // c) "No known allergies" recorded BEFORE the document's date: no conflict.
  const c = await person();
  await prisma.allergyStatusEntry.create({ data: { patientId: c.patientId, facilityId: c.facilityId, status: "NO_KNOWN_ALLERGIES", previousStatus: null, reason: "RECORDED", recordedAt: new Date("2025-06-01T00:00:00Z"), sequence: 1, recordedByUserId: by } });
  await uploadAndConfirm(c.userId, "rx-en-2");
  report("'No known allergies' recorded before the document's date: no conflict", (await prisma.recordConflict.count({ where: { personId: c.personId, kind: "ALLERGY" } })) === 0);

  // d) With the upload shared, the bridged allergy is active: 'no known allergies' is refused.
  const d = await person();
  await decidePersonConsent({ userId: d.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  await uploadAndConfirm(d.userId, "rx-en-2");
  report("A shared patient-reported allergy (bridged, UNCONFIRMED) is active: 'no known allergies' is refused",
    (await prisma.allergy.count({ where: { patientId: d.patientId, source: "PATIENT_PROVIDED", status: "ACTIVE" } })) === 1
      && await refused(recordAllergyStatus({ patientId: d.patientId, facilityId: d.facilityId, status: "NO_KNOWN_ALLERGIES", byUserId: by })));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
