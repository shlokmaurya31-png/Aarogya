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
 *     done), JSON on request, 401, 400 for an unknown key, 404, 413;
 *   - RAG Phase 3, step 3.6: an imported value is labelled, never the latest
 *     when a verified one exists, a disagreement is stated, staff only.
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
  const a = await registerPatientAccount({ facilityId: PUNE, fullName: name, email, passwordHash: await hashPassword(PASSWORD), sex: "F", dob: new Date("1980-04-04"), phone: `98${String(10_000_000 + ((parseInt(tag, 36) * 7 + seq) % 90_000_000)).slice(-8)}` });
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

const gateStarted = new Date();
/**
 * RAG Phase 4: a lookup its readers answer in full ("What was the hemoglobin?") is answered at Tier 0, without the
 * provider. The checks of the provider's path ask a question that also needs the note, so the provider answers it;
 * the hemoglobin reader's fact is still its source [1] (structured facts first).
 */
const MODEL_Q = "What was the hemoglobin, and what does the progress note say about it?";

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
  const qa = await askAi(doctor.actor, { mode: "CHART_QA", patientId: P.patientId, question: MODEL_Q }, { onMeta: () => { streamed.push("meta"); }, onSentence: () => { streamed.push("sentence"); } });
  report("Chart Q&A: ANSWERED, the AI-generated label, the hemoglobin value cited", qa.outcome === "ANSWERED" && qa.meta.label === ADVISORY_LABEL && qa.sentences.some((s) => s.text.includes("11.2 g/dL") && s.citations.length > 0));
  report("…every factual line cites retrieved sources and is labelled verified; citations link into the record",
    qa.sentences.every((s) => s.kind !== "FACT" || (s.citations.length > 0 && s.labels.includes("verified"))) && qa.citations.every((c) => c.origin === "VERIFIED" && c.link.startsWith("/hospital-os/doctor/patients/")));
  report("…streamed: the meta first, then the sentences as they passed", streamed[0] === "meta" && streamed.slice(1).every((x) => x === "sentence") && streamed.length === qa.sentences.length + 1);
  const row = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: qa.meta.interactionId } });
  report("The interaction: metadata (mode, path ids, scores, cited ⊆ retrieved, model, space), staff text encrypted for at most 90 days",
    row.outcome === "ANSWERED" && row.mode === "CHART_QA" && row.facilityId === PUNE && row.citedChunkIds.every((id) => row.retrievedChunkIds.includes(id)) && row.model === "mock-record-1" && !!row.embeddingModel
      && row.textScope === "STAFF_SAFETY" && !!row.questionCiphertext && !row.questionCiphertext.includes("hemoglobin") && decryptText(row.questionCiphertext, row.keyVersion!) === MODEL_Q
      && row.textExpiresAt!.getTime() - row.createdAt.getTime() <= 90 * 86_400_000);

  // RAG Phase 4, Tier 0: the same lookup, answered by its reader's fact, with no provider call.
  const sentBefore = rec.sent.length;
  const t0 = await ask(doctor.actor, { mode: "CHART_QA", question: "What was the hemoglobin?" });
  const t0Row = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: t0.meta.interactionId } });
  report("Tier 0: a lookup its reader answers in full is answered from the reader's fact, cited and labelled, with no provider call",
    t0.outcome === "ANSWERED" && rec.sent.length === sentBefore && t0.sentences.some((s) => s.text.includes("11.2 g/dL") && s.citations.length === 1 && s.labels.includes("verified"))
      && t0Row.tier === 0 && t0Row.model === "none" && t0Row.inputTokens === 0 && t0Row.outputTokens === 0 && t0Row.embeddingTokens === 0, `tier ${t0Row.tier}, model ${t0Row.model}`);
  const qaAcc = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: qa.meta.interactionId } });
  report("Accounting: the provider's request records tokens, the query embedding, the tier, and an estimated cost (never zero for work done)",
    qaAcc.tier === 2 && qaAcc.inputTokens > 0 && qaAcc.outputTokens > 0 && qaAcc.embeddingTokens > 0 && qaAcc.estimatedCostMicroUsd > 0 && qaAcc.retrievalMs !== null, `in ${qaAcc.inputTokens}, out ${qaAcc.outputTokens}, emb ${qaAcc.embeddingTokens}, cost ${qaAcc.estimatedCostMicroUsd}`);

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
  const staffBad = await ask(doctor.actor, { mode: "CHART_QA", question: MODEL_Q });
  report("A number not in the cited source stops a staff answer there (CITATION_INVALID; the valid line before it stands)", staffBad.outcome === "CITATION_INVALID" && staffBad.sentences.length === 1 && staffBad.sentences[0].text === "Hemoglobin was 11.2 g/dL.");
  setRecordAnswerProviderForTest(liar([{ text: "Hemoglobin was 11.2 g/dL.", citations: [1], kind: "FACT" }, { text: "Your report is normal.", citations: [], kind: "FACT" }]));
  const patientBad = await ask(P.actor, { mode: "EXPLAIN_REPORT", documentId: hb.id });
  report("An uncited fact withholds a patient answer whole", patientBad.outcome === "CITATION_INVALID" && patientBad.sentences.length === 0);
  setRecordAnswerProviderForTest(liar([{ text: "See [9].", citations: [9], kind: "FACT" }]));
  report("A citation to a source that wasn't retrieved is invalid", (await ask(doctor.actor, { mode: "CHART_QA", question: MODEL_Q })).outcome === "CITATION_INVALID");
  setRecordAnswerProviderForTest({ id: "mock", async answerFromRecord() { throw new RecordAiUnavailableError("PROVIDER_UNAVAILABLE"); } });
  const down = await ask(doctor.actor, { mode: "CHART_QA", question: MODEL_Q }).then(() => null, (e) => e);
  report("The provider down: 503 (never the mock), the interaction recorded as ERROR", down instanceof AskError && down.status === 503 && (await prisma.aiInteraction.findFirst({ where: { userId: doctor.userId, outcome: "ERROR" } })) !== null);
  setRecordAnswerProviderForTest(rec.p);

  // 6. Identifiers never reach the provider.
  const prompts = JSON.stringify(rec.sent);
  report("No name, UHID or phone in anything sent to the provider (masked)", !prompts.includes(`Anjali Deshmukh ${tag}`) && !prompts.includes(uhid.uhid) && !prompts.includes(uhid.phone!) && prompts.includes("[redacted]"));

  // RAG Phase 4, step 4.6 — the compact context (§11.4).
  {
    const other = await patient(`Ravi Kulkarni ${tag}`);
    const otherUhid = (await prisma.patient.findUniqueOrThrow({ where: { id: other.patientId }, select: { uhid: true } })).uhid;
    const turns = [{ question: "Any recent labs?", answer: "Hemoglobin was checked." }];
    report("K1: a context of more than four turns is refused (400)", await refusedWith(ask(doctor.actor, { mode: "CHART_QA", question: MODEL_Q, context: { turns: Array.from({ length: 5 }, () => turns[0]) } }), 400));
    report("K1: a context over its token cap is refused, never truncated (400 CONTEXT_TOO_LONG)", await ask(doctor.actor, { mode: "CHART_QA", question: MODEL_Q, context: { turns: Array.from({ length: 4 }, () => ({ question: "What did we decide about the anaemia work-up?", answer: "We went over the anaemia work-up, the iron studies and the follow-up plan in detail. ".repeat(12) })) } }).then(() => "", (e) => (e instanceof AskError ? `${e.status} ${e.code}` : String(e))) === "400 CONTEXT_TOO_LONG");
    report("K1: a context without a question is refused (400)", await refusedWith(ask(doctor.actor, { mode: "VISIT_BRIEF", context: { turns } }), 400));
    rec.sent.length = 0;
    const base = await ask(doctor.actor, { mode: "CHART_QA", question: MODEL_Q });
    const withCtx = await ask(doctor.actor, { mode: "CHART_QA", question: MODEL_Q, context: { summary: `Earlier: Anjali Deshmukh ${tag} (phone ${uhid.phone}) and also ${`Ravi Kulkarni ${tag}`}, UHID ${otherUhid}; her hemoglobin was 9.1 g/dL.`, turns } });
    const sent = rec.sent[rec.sent.length - 1];
    report("K2: the context reaches the provider as earlier turns, masked like the question (no name or phone of the patient)", !!sent?.conversation && sent.conversation.includes("[redacted]") && !sent.conversation.includes(`Anjali Deshmukh ${tag}`) && !sent.conversation.includes(uhid.phone!));
    report("K2: the context is never a source: no source the provider receives carries its text", !!sent && !JSON.stringify(sent.sources).includes("9.1 g/dL") && !JSON.stringify(sent.sources).includes("Kulkarni"));
    const [b, c] = [await prisma.aiInteraction.findUniqueOrThrow({ where: { id: base.meta.interactionId } }), await prisma.aiInteraction.findUniqueOrThrow({ where: { id: withCtx.meta.interactionId } })];
    report("K4: it never widens the scope: naming another patient retrieves exactly what the question alone retrieves, none of the other patient's record",
      JSON.stringify([...c.retrievedChunkIds].sort()) === JSON.stringify([...b.retrievedChunkIds].sort()) && c.patientId === P.patientId
        && (await prisma.ragChunk.count({ where: { id: { in: c.retrievedChunkIds }, patientId: other.patientId } })) === 0);
    report("K5: stored only where the question's text is (encrypted with it), and nowhere else on the row",
      !!c.questionCiphertext && decryptText(c.questionCiphertext, c.keyVersion!).includes("9.1 g/dL") && !JSON.stringify({ ...c, questionCiphertext: null, answerCiphertext: null }).includes("9.1"));
    // A number only in the context fails validation.
    setRecordAnswerProviderForTest(liar([{ text: "Her hemoglobin was 9.1 g/dL.", citations: [1], kind: "FACT" }]));
    const fromCtx = await ask(doctor.actor, { mode: "CHART_QA", question: MODEL_Q, context: { summary: "her hemoglobin was 9.1 g/dL" } });
    setRecordAnswerProviderForTest(rec.p);
    report("K3: nothing in the context passes validation as a fact (a number only in it: CITATION_INVALID)", fromCtx.outcome === "CITATION_INVALID" && !fromCtx.sentences.some((s) => s.text.includes("9.1")));
    const unassigned = await staff("NURSE");
    report("K6: every turn re-runs access: an unassigned nurse with a context naming the patient is still refused (404)", await refusedWith(ask(unassigned.actor, { mode: "CHART_QA", question: "allergies?", context: { summary: `We were discussing Anjali Deshmukh ${tag}.` } }), 404));
  }

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
    (await readInteractionText({ interactionId: qa.meta.interactionId, reader: { userId: advisor.id, role: "SAFETY_OFFICER" }, reasonCode: "SAFETY_INCIDENT", ticketRef: "SI-77" })).question === MODEL_Q
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

  // RAG Phase 3, step 3.6 (§13 decision 6) — imported results: labelled, never the latest when a verified one exists, a disagreement stated.
  {
    const I = await patient(`Imported ${tag}`);
    const o = await prisma.labOrder.create({ data: { encounterId: I.encounterId, patientId: I.patientId, testName: "Hemoglobin", category: "Hematology", orderedByStaffId: doctor.staffId } });
    const v = await prisma.labResult.create({ data: { labOrderId: o.id, value: "11.4", unit: "g/dL", referenceRange: "12.0 - 15.5", abnormalFlag: "LOW", status: "VERIFIED", resultedAt: new Date("2026-10-10T08:00:00Z") } });
    await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LabResultReleased", aggregateId: v.id, facilityId: PUNE, payload: { resultId: v.id, orderId: o.id, patientId: I.patientId } }));
    for (const [testName, value, at] of [["Hemoglobin", "9.8", "2026-11-05T08:00:00Z"], ["TSH", "3.1", "2025-02-02T08:00:00Z"]] as const) {
      const l = await prisma.legacyLabResult.create({ data: { facilityId: PUNE, patientId: I.patientId, batchId: `ask-${tag}`, sourceSystem: "OldHIS", testCode: testName, testName, value, unit: testName === "TSH" ? "µIU/mL" : "g/dL", observedAt: new Date(at) } });
      await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LegacyResultImported", aggregateId: l.id, facilityId: PUNE, payload: { resultId: l.id, patientId: I.patientId, batchId: `ask-${tag}`, converted: false } }));
    }
    await drain();
    const askI = async (question: string) => { await cool(doctor.actor.userId); return askAi(doctor.actor, { mode: "CHART_QA", patientId: I.patientId, question }); };
    const latest = await askI("What was the latest hemoglobin?");
    const facts = latest.sentences.filter((x) => x.kind === "FACT");
    report("Imported: the latest haemoglobin is the verified value, though the imported one is newer", facts[0]?.text.includes("11.4") && facts[0].labels.includes("verified") && !facts[0].labels.includes("imported"), facts[0]?.text);
    report("Imported: every line with the imported value is labelled imported", facts.filter((x) => x.text.includes("9.8")).length > 0 && facts.filter((x) => x.text.includes("9.8")).every((x) => x.labels.includes("imported") && !x.labels.includes("verified")));
    report("Imported: the disagreement is stated", facts.some((x) => /differs from the latest verified value 11\.4/.test(x.text)), facts.map((x) => x.text).join(" | "));
    const tsh = await askI("What was the latest TSH?");
    report("Imported: with no verified value, the imported one is given, labelled imported", tsh.outcome === "ANSWERED" && tsh.sentences.some((x) => x.kind === "FACT" && x.text.includes("3.1") && x.labels.includes("imported")) && tsh.citations.every((c) => c.origin === "IMPORTED"));
    const indexed = await prisma.ragChunk.findMany({ where: { patientId: I.patientId, sourceType: "LEGACY_LAB_RESULT", status: "ACTIVE" }, select: { origin: true, audience: true } });
    report("Imported: indexed by the rag-indexer as IMPORTED, staff only", indexed.length === 2 && indexed.every((c) => c.origin === "IMPORTED" && c.audience === "STAFF_ONLY"));
    const narrative = await askI("imported result from OldHIS");
    report("Imported: a narrative question finds the imported passages, labelled", narrative.sentences.some((x) => x.kind === "FACT" && /Imported result from OldHIS/.test(x.text) && x.labels.includes("imported")), narrative.sentences.map((x) => x.text).join(" | "));
    await cool(I.userId);
    const own = await askAi(I.actor, { mode: "HEALTH_TIMELINE", patientId: I.patientId });
    report("Imported: never in the patient's own modes (staff only)", !own.sentences.some((x) => /OldHIS|9\.8/.test(x.text)) && !own.citations.some((c) => c.origin === "IMPORTED"));
  }

  // RAG Phase 1, step 1.7 — what every answer rested on, and what it cost.
  {
    const rows = await prisma.aiInteraction.findMany({ where: { createdAt: { gte: gateStarted }, mode: { not: "ASSISTANT" }, outcome: { in: ["ANSWERED", "CITATION_INVALID"] } }, include: { sources: true } });
    report("Attribution: answered requests exist to check", rows.length >= 5, String(rows.length));
    const bad = rows.filter((r) => r.sources.length !== r.retrievedChunkIds.length
      || r.sources.filter((x) => x.cited).length !== r.citedChunkIds.length
      || r.sources.some((x) => x.sourceKind === "CHUNK" && !r.retrievedChunkIds.includes(x.chunkId!)));
    report("Attribution: every answered request has one source row per source, the cited ones marked", bad.length === 0, `${bad.length} of ${rows.length} differ`);
    const chunkRows = rows.flatMap((r) => r.sources).filter((x) => x.sourceKind === "CHUNK");
    report("Attribution: an index source names its document and version", chunkRows.length > 0 && chunkRows.every((x) => x.ragDocumentId && x.sourceVersion !== null));
    // The table has no text column at all; and nothing in it carries a chunk's text.
    const texts = (await prisma.ragChunk.findMany({ where: { id: { in: chunkRows.map((x) => x.chunkId!) } }, select: { text: true } })).map((c) => c.text);
    const asJson = JSON.stringify(rows.flatMap((r) => r.sources));
    report("Attribution: no source row holds text", texts.length > 0 && texts.every((t) => !asJson.includes(t)));
    report("Accounting: answered requests record module, provider, tier 2 and timings", rows.every((r) => r.module && r.provider === "mock" && r.tier === 2 && r.retrievalMs !== null && r.generationMs !== null));
    const noModel = await prisma.aiInteraction.findMany({ where: { createdAt: { gte: gateStarted }, outcome: { in: ["NO_RECORD", "REFUSED_SAFETY"] }, provider: null }, select: { tier: true } });
    report("Accounting: an answer given without a model is tier 0", noModel.length > 0 && noModel.every((r) => r.tier === 0));
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
