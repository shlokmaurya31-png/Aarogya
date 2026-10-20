/**
 * Week 4b, RAG step 8 — POST /api/ai/ask (docs/RAG_DESIGN.md §8–§9), on the
 * mock models:
 *   - each mode allowed or refused per role and access path; a nurse's
 *     unassigned patient refused; an assigned nurse's handoff has the doses
 *     due and missed;
 *   - every answer carries the AI-generated label; every factual line cites
 *     retrieved sources and is labelled (verified / patient-provided /
 *     translated / handwritten / not yet confirmed);
 *   - patient diagnosis, dosing and urgent-symptom questions refused (the
 *     emergency line only for an urgent one) before anything is retrieved;
 *   - an invalid citation or a number not in the cited source stops a staff
 *     answer there and withholds a patient answer whole;
 *   - "no record" below the threshold, without asking the model;
 *   - 429 at the limit (metadata still kept); 503 when the provider is down;
 *   - identifiers never reach the provider; nothing is written to the record;
 *   - text: staff text encrypted (90 days); patient text only with the opt-in,
 *     readable by reviewers only with SAFETY_REVIEW; every read logged,
 *     audited and in the monthly report; others can't read it;
 *   - over HTTP: server-sent events in order (meta, sentences, citations,
 *     done), JSON on request, 401, 400 for an unknown key, 404, 413.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-ai-ask.ts [--no-build]
 */
import "./lib/gateBootstrap";
import { randomBytes } from "node:crypto";
import { prisma } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth/password";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { emitFacilityEvent } from "../src/lib/events/facilityEvent";
import { createNote } from "../src/lib/hospital/clinicalNote";
import { recordAllergy } from "../src/lib/hospital/clinicalRecords";
import { decidePersonConsent } from "../src/lib/person/consent";
import { uploadPersonDocument } from "../src/lib/person/documents";
import { fixtureById, fixturePdf } from "../src/lib/documents/fixtures";
import { setDocumentProvidersForTest } from "../src/lib/ai/documents";
import { bulkReview, listOwnFacts } from "../src/lib/documents/review";
import { getRecordAnswerProvider, RecordAiUnavailableError, setRecordAnswerProviderForTest, type AnswerRequest, type RecordAnswerProvider } from "../src/lib/ai/record";
import { askAi, AskError, LIMITS, type AskRequest } from "../src/lib/rag/ask";
import { decryptText } from "../src/lib/rag/textCrypto";
import { monthlyReviewReport, purgeExpiredAiInteractions, readInteractionText } from "../src/lib/rag/interactions";
import { ADVISORY_LABEL } from "../src/lib/rag/modes";
import { PHRASES } from "../src/lib/rag/phrases";
import type { AiActor } from "../src/lib/rag/access";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";
import { loginAs, startServer } from "./lib/appServer";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const tag = Date.now().toString(36).replace(/[^a-z0-9]/g, "");
const PUNE = "fac-amc-pune";
const PASSWORD = `Gate-${tag}-pw1`;
let seq = 0;
let clock = Date.now();

// Encryption key for this run (the gate's own; never a real key).
process.env.AI_TEXT_KEY_VERSION = "1";
process.env.AI_TEXT_KEY_1 = randomBytes(32).toString("base64");

async function drain() {
  for (let i = 0; i < 40; i++) {
    clock += 2 * 3_600_000;
    const r = await dispatchPendingDomainEvents({ now: new Date(clock), batchSize: 500, maxDurationMs: 60_000 });
    if (r.claimed === 0) return;
  }
}

async function staff(role: "DOCTOR" | "NURSE") {
  seq += 1;
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: PUNE }, select: { id: true } });
  const user = await prisma.user.create({ data: { email: `ai-ask-${role.toLowerCase()}-${tag}-${seq}@verify.aarogya`, passwordHash: await hashPassword(PASSWORD), role, displayName: `Ask ${role} ${seq}` } });
  const profile = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: role === "NURSE" ? "Ward Nurse" : "Physician" } });
  await ensurePrimaryMembership(prisma, user.id, PUNE, { isAdmin: false });
  return { userId: user.id, staffId: profile.id, email: user.email, actor: { kind: "STAFF", userId: user.id, role, facilityId: PUNE } as AiActor };
}

async function patient(name: string) {
  seq += 1;
  const email = `ai-ask-pt-${tag}-${seq}@verify.aarogya`;
  const a = await registerPatientAccount({ facilityId: PUNE, fullName: name, email, passwordHash: await hashPassword(PASSWORD), sex: "F", dob: new Date("1980-04-04"), phone: `98${String(10_000_000 + seq).slice(-8)}` });
  if (a.status !== "LINKED_NEW") throw new Error("fixture patient");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC" } });
  const link = await prisma.personPatientLink.findFirstOrThrow({ where: { personId, status: "ACTIVE" } });
  const enc = await prisma.encounter.create({ data: { patientId: link.patientId, facilityId: PUNE, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "ask gate" } });
  return { userId: a.userId, email, personId, patientId: link.patientId, encounterId: enc.id, actor: { kind: "PATIENT", userId: a.userId } as AiActor };
}

/** Wraps the configured provider to record every request it is sent (and count calls). */
function recorder(inner: RecordAnswerProvider) {
  const sent: AnswerRequest[] = [];
  const p: RecordAnswerProvider = { id: "mock", async answerFromRecord(req, permit) { sent.push(req); return inner.answerFromRecord(req, permit); } };
  return { p, sent };
}

/** Moves a user's earlier interactions two minutes back (the gate's clock), so the per-minute limit covers only what a check means it to. */
const cool = (userId: string) => prisma.$executeRaw`UPDATE "AiInteraction" SET "createdAt" = "createdAt" - interval '2 minutes', "textExpiresAt" = "textExpiresAt" - interval '2 minutes' WHERE "userId" = ${userId} AND "createdAt" > now() - interval '2 minutes'`;
const refusedWith = async (p: Promise<unknown>, status: number) => p.then(() => false, (e) => e instanceof AskError && e.status === status);

async function main() {
  registerAllConsumers();
  setDocumentProvidersForTest(null);
  const doctor = await staff("DOCTOR");
  const nurse = await staff("NURSE");
  const P = await patient(`Anjali Deshmukh ${tag}`);
  const uhid = (await prisma.patient.findUniqueOrThrow({ where: { id: P.patientId }, select: { uhid: true, phone: true } }));
  // The record.
  await createNote({ encounterId: P.encounterId, authorStaffId: doctor.staffId, authorRole: "DOCTOR", type: "PROGRESS", content: { subjective: `Fever and cough for 3 days. Daughter's number ${uhid.phone}.`, plan: "Chest X-ray; review tomorrow." }, sign: true, byUserId: doctor.userId });
  const order = await prisma.labOrder.create({ data: { encounterId: P.encounterId, patientId: P.patientId, testName: "Hemoglobin", category: "Hematology", orderedByStaffId: doctor.staffId } });
  const hb = await prisma.labResult.create({ data: { labOrderId: order.id, value: "11.2", unit: "g/dL", referenceRange: "12.0 - 15.5", abnormalFlag: "LOW", status: "VERIFIED", resultedAt: new Date("2026-10-10T08:00:00Z") } });
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LabResultReleased", aggregateId: hb.id, facilityId: PUNE, payload: { resultId: hb.id, orderId: order.id, patientId: P.patientId } }));
  await recordAllergy({ patientId: P.patientId, facilityId: PUNE, substance: "Penicillin", reaction: "rash", severity: "severe", byUserId: doctor.userId });
  const med = await prisma.medicationOrder.create({ data: { encounterId: P.encounterId, patientId: P.patientId, drugName: "Amoxicillin", dose: "500 mg", route: "ORAL", frequency: "TDS", orderedByStaffId: doctor.staffId, status: "ACTIVE" } });
  await prisma.medicationAdministration.create({ data: { medicationOrderId: med.id, scheduledAt: new Date(Date.now() - 2 * 3_600_000), status: "MISSED" } });
  await prisma.medicationAdministration.create({ data: { medicationOrderId: med.id, scheduledAt: new Date(Date.now() + 2 * 3_600_000), status: "DUE" } });
  await uploadPersonDocument(P.userId, { bytes: await fixturePdf(fixtureById("lab-hi-kft")!), contentType: "application/pdf", originalName: "kft.pdf", title: "Outside KFT", type: "REPORT" });
  await drain();
  const upload = await prisma.personDocument.findFirstOrThrow({ where: { personId: P.personId, title: "Outside KFT" } });

  const mock = getRecordAnswerProvider({});
  const rec = recorder(mock);
  setRecordAnswerProviderForTest(rec.p);
  const ask = async (actor: AiActor, r: Partial<AskRequest> & { mode: AskRequest["mode"] }) => { await cool(actor.userId); return askAi(actor, { patientId: P.patientId, ...r }); };
  const recordCounts = async () => [await prisma.clinicalNote.count(), await prisma.diagnosis.count(), await prisma.medicationOrder.count(), await prisma.allergy.count(), await prisma.task.count(), await prisma.labOrder.count(), await prisma.domainEventOutbox.count()].join();
  const before = await recordCounts();

  // 1. Chart Q&A by the treating doctor.
  const streamed: string[] = [];
  const qa = await askAi(doctor.actor, { mode: "CHART_QA", patientId: P.patientId, question: "What was the hemoglobin?" }, { onMeta: () => { streamed.push("meta"); }, onSentence: () => { streamed.push("sentence"); } });
  report("Chart Q&A: ANSWERED, the AI-generated label, the hemoglobin value cited", qa.outcome === "ANSWERED" && qa.meta.label === ADVISORY_LABEL && qa.sentences.some((s) => s.text.includes("11.2 g/dL") && s.citations.length > 0));
  report("…every factual line cites retrieved sources and is labelled verified; citations link into the record",
    qa.sentences.every((s) => s.kind !== "FACT" || (s.citations.length > 0 && s.labels.includes("verified"))) && qa.citations.every((c) => c.origin === "VERIFIED" && c.link.startsWith("/hospital-os/doctor/patients/")));
  report("…streamed: the meta first, then the sentences as they passed", streamed[0] === "meta" && streamed.slice(1).every((x) => x === "sentence") && streamed.length === qa.sentences.length + 1);
  const row = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: qa.meta.interactionId } });
  report("The interaction: metadata (mode, path ids, scores, cited ⊆ retrieved, model, space), staff text encrypted for at most 90 days",
    row.outcome === "ANSWERED" && row.mode === "CHART_QA" && row.facilityId === PUNE && row.citedChunkIds.every((id) => row.retrievedChunkIds.includes(id)) && row.model === "mock-record-1" && !!row.embeddingModel
      && row.textScope === "STAFF_SAFETY" && !!row.questionCiphertext && !row.questionCiphertext.includes("hemoglobin") && decryptText(row.questionCiphertext, row.keyVersion!) === "What was the hemoglobin?"
      && row.textExpiresAt!.getTime() - row.createdAt.getTime() <= 90 * 86_400_000);

  // 2. Modes per role and path.
  report("The doctor's visit brief: answered, with the allergy and live medicine in it", await ask(doctor.actor, { mode: "VISIT_BRIEF" }).then((r) => r.outcome === "ANSWERED" && r.sentences.some((s) => s.text.includes("Penicillin")) && r.sentences.some((s) => s.text.includes("Amoxicillin"))));
  report("A doctor can't use the nurse handoff or the patient modes (403)", await refusedWith(ask(doctor.actor, { mode: "NURSE_HANDOFF" }), 403) && await refusedWith(ask(doctor.actor, { mode: "EXPLAIN_REPORT", documentId: hb.id }), 403));
  report("A nurse asking about a patient not assigned to them: 404", await refusedWith(ask(nurse.actor, { mode: "CHART_QA", question: "allergies?" }), 404));
  await prisma.nursingAssignment.create({ data: { facilityId: PUNE, nurseStaffId: nurse.staffId, patientId: P.patientId, assignedByStaffId: doctor.staffId, startAt: new Date(Date.now() - 3_600_000) } });
  const handoff = await ask(nurse.actor, { mode: "NURSE_HANDOFF" });
  report("Assigned: the nurse handoff has the missed and the due dose", handoff.outcome === "ANSWERED" && handoff.sentences.some((s) => s.text.startsWith("Dose missed: Amoxicillin")) && handoff.sentences.some((s) => s.text.startsWith("Dose due: Amoxicillin")));
  report("A patient can't use the staff modes (403)", await refusedWith(ask(P.actor, { mode: "CHART_QA", question: "x" }), 403) && await refusedWith(ask(P.actor, { mode: "VISIT_BRIEF" }), 403));
  const explain = await ask(P.actor, { mode: "EXPLAIN_REPORT", documentId: hb.id });
  report("Explain my report (the patient's own lab result): the report's own line, labelled, opened by the fixed line", explain.outcome === "ANSWERED" && explain.sentences[0].text === PHRASES.en.reportSays && explain.sentences.some((s) => s.text.includes("11.2 g/dL (reference 12.0 - 15.5), low") && s.labels.includes("verified")));
  const hi = await ask(P.actor, { mode: "EXPLAIN_REPORT", documentId: hb.id, language: "hi" });
  report("…in Hindi: the opening line in Hindi, the values as printed, labelled translated", hi.sentences[0].text === PHRASES.hi.reportSays && hi.sentences.some((s) => s.text.includes("11.2") && s.labels.includes("translated")));
  await cool(P.userId);
  report("Explaining a report outside the patient's scope: 404", await refusedWith(askAi(P.actor, { mode: "EXPLAIN_REPORT", patientId: P.patientId, documentId: "not-a-report" }), 404));
  const unconfirmed = await ask(P.actor, { mode: "EXPLAIN_REPORT", documentId: upload.id });
  report("Explaining the patient's own upload before review: read directly, every line labelled \"not yet confirmed by you\"",
    unconfirmed.outcome === "ANSWERED" && unconfirmed.sentences[0].text === PHRASES.en.unconfirmed && unconfirmed.sentences.filter((s) => s.kind === "FACT").every((s) => s.labels.includes("not yet confirmed by you") && s.labels.includes("patient-provided")));
  report("The timeline and pre-visit questions answer the patient; the questions are questions", await ask(P.actor, { mode: "HEALTH_TIMELINE" }).then((r) => r.outcome === "ANSWERED")
    && await ask(P.actor, { mode: "PREVISIT_QUESTIONS" }).then((r) => r.outcome === "ANSWERED" && r.sentences.filter((s) => s.kind === "FACT").every((s) => s.text.endsWith("?"))));

  // 3. Patient safety rules, before retrieval.
  const calls = rec.sent.length;
  const dx = await ask(P.actor, { mode: "EXPLAIN_REPORT", documentId: hb.id, question: "Do I have anaemia?" });
  const dose = await ask(P.actor, { mode: "EXPLAIN_REPORT", documentId: hb.id, question: "Should I stop amoxicillin?" });
  const urgent = await ask(P.actor, { mode: "EXPLAIN_REPORT", documentId: hb.id, question: "I have chest pain now, what does this mean?" });
  report("A diagnosis question and a dosing question are refused: \"please ask your care team\", nothing else",
    dx.outcome === "REFUSED_SAFETY" && dose.outcome === "REFUSED_SAFETY" && [dx, dose].every((r) => r.sentences.length === 1 && r.sentences[0].text === PHRASES.en.askCareTeam && r.citations.length === 0));
  report("An urgent symptom gets the emergency line and nothing else", urgent.outcome === "REFUSED_SAFETY" && urgent.sentences.length === 1 && urgent.sentences[0].text === PHRASES.en.emergency);
  report("…none of them retrieved anything or asked the model", rec.sent.length === calls && (await prisma.aiInteraction.findMany({ where: { id: { in: [dx.meta.interactionId, urgent.meta.interactionId] } } })).every((r) => r.retrievedChunkIds.length === 0));

  // 4. No record.
  const nr = await ask(doctor.actor, { mode: "CHART_QA", question: "What is the blood group and Rh type?" });
  report("Not in the record: NO_RECORD (\"I couldn't find this in the record\"), the model not asked", nr.outcome === "NO_RECORD" && nr.sentences[0].text === PHRASES.en.noRecord && rec.sent.length === calls);

  // 5. Invalid citations and numbers.
  const liar = (sentences: AnswerRequest extends never ? never : { text: string; citations: number[]; kind: "FACT" | "GUIDANCE" }[]): RecordAnswerProvider => ({ id: "mock", async answerFromRecord() { return { outcome: "ANSWERED", sentences, model: "liar", inputTokens: 0, outputTokens: 0 }; } });
  setRecordAnswerProviderForTest(liar([{ text: "Hemoglobin was 11.2 g/dL.", citations: [1], kind: "FACT" }, { text: "Hemoglobin was 12.4 g/dL.", citations: [1], kind: "FACT" }, { text: "It improved.", citations: [1], kind: "FACT" }]));
  const staffBad = await ask(doctor.actor, { mode: "CHART_QA", question: "What was the hemoglobin?" });
  report("A number not in the cited source stops a staff answer there (CITATION_INVALID; the valid line before it stands)", staffBad.outcome === "CITATION_INVALID" && staffBad.sentences.length === 1 && staffBad.sentences[0].text === "Hemoglobin was 11.2 g/dL.");
  setRecordAnswerProviderForTest(liar([{ text: "Hemoglobin was 11.2 g/dL.", citations: [1], kind: "FACT" }, { text: "Your report is normal.", citations: [], kind: "FACT" }]));
  const patientBad = await ask(P.actor, { mode: "EXPLAIN_REPORT", documentId: hb.id });
  report("An uncited fact withholds a patient answer whole", patientBad.outcome === "CITATION_INVALID" && patientBad.sentences.length === 0);
  setRecordAnswerProviderForTest(liar([{ text: "See [9].", citations: [9], kind: "FACT" }]));
  report("A citation to a source that wasn't retrieved is invalid", (await ask(doctor.actor, { mode: "CHART_QA", question: "What was the hemoglobin?" })).outcome === "CITATION_INVALID");
  setRecordAnswerProviderForTest({ id: "mock", async answerFromRecord() { throw new RecordAiUnavailableError("PROVIDER_UNAVAILABLE"); } });
  const down = await ask(doctor.actor, { mode: "CHART_QA", question: "What was the hemoglobin?" }).then(() => null, (e) => e);
  report("The provider down: 503 (never the mock), the interaction recorded as ERROR", down instanceof AskError && down.status === 503 && (await prisma.aiInteraction.findFirst({ where: { userId: doctor.userId, outcome: "ERROR" } })) !== null);
  setRecordAnswerProviderForTest(rec.p);

  // 6. Identifiers never reach the provider.
  const prompts = JSON.stringify(rec.sent);
  report("No name, UHID or phone in anything sent to the provider (masked)", !prompts.includes(`Anjali Deshmukh ${tag}`) && !prompts.includes(uhid.uhid) && !prompts.includes(uhid.phone!) && prompts.includes("[redacted]"));

  // 7. Patient-provided lines are labelled; nothing was written to the record.
  await decidePersonConsent({ userId: P.userId, purpose: "SHARE_UPLOADS_WITH_TREATING", decision: "GRANTED" });
  const facts = await listOwnFacts(P.userId);
  await bulkReview(P.userId, { decisions: facts.map((f) => ({ factId: f.id, version: f.version, decision: "CONFIRM" })) });
  await drain();
  const before2 = await recordCounts();
  const pp = await ask(doctor.actor, { mode: "CHART_QA", question: "What was the creatinine on the uploaded report?" });
  report("A patient-provided fact (shared, treating) is cited and labelled patient-provided", pp.sentences.some((s) => s.text.includes("1.42") && s.labels.includes("patient-provided")) && pp.citations.some((c) => c.origin === "PATIENT_PROVIDED"));
  report("Nothing is ever written to the record by asking (notes, diagnoses, orders, allergies, tasks, events unchanged)", (await recordCounts()) === before2 && before.length > 0);

  // 8. Text retention for patients, and reviewers.
  const noOpt = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: explain.meta.interactionId } });
  report("A patient's text is not kept without the opt-in (metadata only)", noOpt.questionCiphertext === null && noOpt.answerCiphertext === null && noOpt.textScope === null);
  await decidePersonConsent({ userId: P.userId, purpose: "AI_TEXT_RETENTION", decision: "GRANTED" });
  const kept = await ask(P.actor, { mode: "EXPLAIN_REPORT", documentId: hb.id, question: "What does hemoglobin measure?" });
  const keptRow = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: kept.meta.interactionId } });
  const advisor = await prisma.user.create({ data: { email: `ai-ask-advisor-${tag}@verify.aarogya`, passwordHash: "x", role: "CLINICAL_ADVISOR", displayName: "Advisor" } });
  report("With the opt-in (no safety review): kept, but reviewers can't read it", keptRow.textScope === "PATIENT_OPT_IN" && !!keptRow.questionCiphertext
    && await readInteractionText({ interactionId: keptRow.id, reader: { userId: advisor.id, role: "CLINICAL_ADVISOR" }, reasonCode: "QUALITY_REVIEW", ticketRef: "QA-1" }).then(() => false, () => true));
  await decidePersonConsent({ userId: P.userId, purpose: "AI_TEXT_RETENTION", decision: "GRANTED", scopes: ["SAFETY_REVIEW"] });
  const reviewable = await ask(P.actor, { mode: "EXPLAIN_REPORT", documentId: hb.id, question: "What does the reference range mean?" });
  const read = await readInteractionText({ interactionId: reviewable.meta.interactionId, reader: { userId: advisor.id, role: "CLINICAL_ADVISOR" }, reasonCode: "QUALITY_REVIEW", ticketRef: `QA-${tag}` });
  report("With SAFETY_REVIEW: the clinical advisor reads it (reason and ticket required)", read.question === "What does the reference range mean?" && read.answer.length > 0);
  report("…the read is logged, audited and in the month's review report",
    (await prisma.aiTextReadLog.count({ where: { interactionId: reviewable.meta.interactionId, ticketRef: `QA-${tag}` } })) === 1
      && (await prisma.auditEvent.count({ where: { type: "ai.interaction.text_read", userId: advisor.id } })) >= 1
      && (await monthlyReviewReport({ role: "SAFETY_OFFICER" }, new Date().toISOString().slice(0, 7))).reads.some((r) => r.ticketRef === `QA-${tag}`));
  report("Staff text is readable by a reviewer; a doctor can read none; a read without a ticket is refused",
    (await readInteractionText({ interactionId: qa.meta.interactionId, reader: { userId: advisor.id, role: "SAFETY_OFFICER" }, reasonCode: "SAFETY_INCIDENT", ticketRef: "SI-77" })).question === "What was the hemoglobin?"
      && await readInteractionText({ interactionId: qa.meta.interactionId, reader: { userId: doctor.userId, role: "DOCTOR" }, reasonCode: "SAFETY_INCIDENT", ticketRef: "SI-77" }).then(() => false, () => true)
      && await readInteractionText({ interactionId: qa.meta.interactionId, reader: { userId: advisor.id, role: "SAFETY_OFFICER" }, reasonCode: "SAFETY_INCIDENT", ticketRef: " " }).then(() => false, () => true));
  await purgeExpiredAiInteractions({ now: new Date(Date.now() + 91 * 86_400_000) });
  report("After 90 days the text is purged by the runner's sweep; the metadata stays", (await prisma.aiInteraction.findUniqueOrThrow({ where: { id: qa.meta.interactionId } })).questionCiphertext === null);

  // 9. Rate limits.
  const R = await patient(`Rate ${tag}`);
  const rr = await prisma.labOrder.create({ data: { encounterId: R.encounterId, patientId: R.patientId, testName: "TSH", category: "Biochemistry", orderedByStaffId: doctor.staffId } });
  const tsh = await prisma.labResult.create({ data: { labOrderId: rr.id, value: "6.8", unit: "µIU/mL", status: "VERIFIED", resultedAt: new Date() } });
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LabResultReleased", aggregateId: tsh.id, facilityId: PUNE, payload: { resultId: tsh.id, orderId: rr.id, patientId: R.patientId } }));
  await drain();
  for (let i = 0; i < LIMITS.PATIENT.perMinute; i++) await askAi(R.actor, { mode: "EXPLAIN_REPORT", patientId: R.patientId, documentId: tsh.id });
  report(`The ${LIMITS.PATIENT.perMinute + 1}th patient request in a minute: 429, recorded as RATE_LIMITED`, await refusedWith(askAi(R.actor, { mode: "EXPLAIN_REPORT", patientId: R.patientId, documentId: tsh.id }), 429)
    && (await prisma.aiInteraction.count({ where: { userId: R.userId, outcome: "RATE_LIMITED" } })) === 1);

  // 10. Over HTTP.
  const { base, child } = await startServer();
  try {
    const H = await patient(`Http ${tag}`);
    const ho = await prisma.labOrder.create({ data: { encounterId: H.encounterId, patientId: H.patientId, testName: "Platelet Count", category: "Hematology", orderedByStaffId: doctor.staffId } });
    const plt = await prisma.labResult.create({ data: { labOrderId: ho.id, value: "245", unit: "x10^3/µL", status: "VERIFIED", resultedAt: new Date() } });
    await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LabResultReleased", aggregateId: plt.id, facilityId: PUNE, payload: { resultId: plt.id, orderId: ho.id, patientId: H.patientId } }));
    await drain();
    const post = (cookie: string | null, body: unknown, accept = "text/event-stream") => fetch(`${base}/api/ai/ask`, { method: "POST", headers: { "content-type": "application/json", accept, ...(cookie ? { cookie } : {}) }, body: typeof body === "string" ? body : JSON.stringify(body) });
    report("HTTP: no session → 401", (await post(null, { mode: "HEALTH_TIMELINE", patientId: H.patientId })).status === 401);
    const pc = await loginAs(base, H.email, PASSWORD);
    const sse = await post(pc, { mode: "EXPLAIN_REPORT", patientId: H.patientId, documentId: plt.id });
    const text = await sse.text();
    const events = [...text.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    report("HTTP: server-sent events: meta, sentences, citations, done (ANSWERED), the label in meta",
      sse.status === 200 && (sse.headers.get("content-type") ?? "").startsWith("text/event-stream") && events[0] === "meta" && events.at(-1) === "done" && events.at(-2) === "citations"
        && events.slice(1, -2).every((e) => e === "sentence") && text.includes(ADVISORY_LABEL) && text.includes('"outcome":"ANSWERED"') && text.includes("245"), events.join(","));
    const json = await post(pc, { mode: "EXPLAIN_REPORT", patientId: H.patientId, documentId: plt.id }, "application/json");
    const jb = await json.json() as { outcome: string; meta: { label: string } };
    report("HTTP: JSON on request, the same answer", json.status === 200 && jb.outcome === "ANSWERED" && jb.meta.label === ADVISORY_LABEL);
    report("HTTP: an unknown key in the body → 400 (strict schema)", (await post(pc, { mode: "HEALTH_TIMELINE", patientId: H.patientId, facilityId: PUNE })).status === 400);
    report("HTTP: someone else's record → 404", (await post(pc, { mode: "HEALTH_TIMELINE", patientId: P.patientId })).status === 404);
    report("HTTP: a body over 16 KB → 413", (await post(pc, JSON.stringify({ mode: "EXPLAIN_REPORT", patientId: H.patientId, documentId: plt.id, question: "x".repeat(17_000) }))).status === 413);
    const dc = await loginAs(base, doctor.email, PASSWORD);
    const ds = await post(dc, { mode: "CHART_QA", patientId: P.patientId, question: "What was the hemoglobin?" });
    report("HTTP: the treating doctor's chart Q&A streams (200)", ds.status === 200 && (await ds.text()).includes("11.2 g/dL"));
  } finally {
    child.kill("SIGTERM");
  }

  setRecordAnswerProviderForTest(null);
  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
