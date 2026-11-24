import "./lib/gateBootstrap";
/**
 * RAG Phase 1, step 1.1 — the portal assistant (POST /api/chat) passes the
 * same checks as /api/ai/ask, through its gateway (src/lib/rag/assistant.ts).
 *
 * Until Phase 1 the route built a record context and sent it to the provider
 * with no real-data switch, AI consent, permit, masking, citation or log.
 * Now the assistant is record-free, and a staff question naming a patient
 * goes to the record gateway. A capturing mock records exactly what reaches
 * the provider, so a check fails if anything of a record does.
 *
 *   1. A patient: the provider is given no record (their allergies, medicines,
 *      name and UHID never reach it); their phone number and ABHA-shaped
 *      numbers are masked out of the message; the interaction is logged
 *      (metadata only, no text).
 *   2. The patient safety rules run before any model: an urgent symptom gets
 *      the emergency line; a dosing question gets "ask your care team"; the
 *      provider is never called.
 *   3. AI consent declined: 403, the provider never called.
 *   4. A REAL Person while the switch is off: 403, the provider never called.
 *      With the switch on and consent granted, the Anthropic provider still
 *      refuses for lack of its own data-policy flag (default off).
 *   5. A login with no Person: refused (it can't have consented).
 *   6. Staff naming a patient: the record gateway. Another facility's patient
 *      is 404; a nurse's unassigned patient is 404; nothing reaches the
 *      assistant provider either way.
 *   7. Staff at a facility where the AI is off: 403.
 *   8. Scholar: a record-free reply, logged with no person or facility.
 *   9. Rate limits counted on the interaction log: the patient's 7th
 *      request within a minute is a 429.
 *  10. RAG Phase 5 (5.7), parity: the same record question through /api/chat
 *      and through /api/ai/ask has the same access result, the same masking
 *      of what reaches the answer provider, the same validation (an invented
 *      number ends CITATION_INVALID on both), and the same log (CHART_QA,
 *      the same sources retrieved and cited, text kept the same way; only
 *      the module differs: CHAT, ASK).
 *  11. RAG Phase 5 (5.7): a staff question about the hospital's documents or
 *      its live state, with no patient, goes to the knowledge or the
 *      operational gateway and gets their answer; never the record-free
 *      assistant.
 *
 * Usage: through `npm run verify:all`.
 */
import { randomUUID } from "node:crypto";
import { Role } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { setAIProviderForTest } from "../src/lib/ai/getAIProvider";
import { MockAIProvider } from "../src/lib/ai/mockProvider";
import { AnthropicAIProvider } from "../src/lib/ai/anthropicProvider";
import { issueAssistantPermit } from "../src/lib/ai/assistantPermit";
import { decidePersonConsent } from "../src/lib/person/consent";
import { chatAboutRecord, chatGeneral, chatStaff } from "../src/lib/rag/assistant";
import { askAi } from "../src/lib/rag/ask";
import { askKnowledge } from "../src/lib/rag/knowledgeAsk";
import { askOps } from "../src/lib/rag/opsAsk";
import { getRecordAnswerProvider, setRecordAnswerProviderForTest, type AnswerRequest, type RecordAnswerProvider } from "../src/lib/ai/record";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { phrase } from "../src/lib/rag/phrases";
import { linkAccountForGate } from "./lib/personFixture";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

const seen: string[] = [];
const mock = new MockAIProvider();
const capturing = Object.assign(Object.create(mock) as MockAIProvider, {
  assistantReply: (input: Parameters<MockAIProvider["assistantReply"]>[0], permit: Parameters<MockAIProvider["assistantReply"]>[1]) => {
    seen.push(JSON.stringify(input));
    return mock.assistantReply(input, permit);
  },
});
const outcome = <T extends { outcome: string }>(p: Promise<T>) => p.then((r) => r.outcome, (e: { status?: number; code?: string }) => `${e?.status ?? "?"} ${e?.code ?? String(e)}`);

async function patientWithPerson(tag: string, facilityId: string) {
  const run = randomUUID().slice(0, 8);
  const patient = await prisma.patient.create({ data: { uhid: `AIASST-${tag}-${run}`, facilityId, fullName: `Assistant ${tag} ${run}`, sex: "F", phone: `98${run.replace(/\D/g, "7").padEnd(8, "7").slice(0, 8)}` } });
  await prisma.allergy.create({ data: { patientId: patient.id, substance: `Allergen${run}`, severity: "MILD" } });
  const user = await prisma.user.create({ data: { email: `ai-assistant-${tag}-${run}@verify.aarogya`, displayName: `Assistant ${tag}`, role: Role.PATIENT, passwordHash: "x" } });
  const { personId } = await linkAccountForGate(prisma, user.id, patient.id);
  return { patient, user, personId, run };
}

async function main() {
  setAIProviderForTest(capturing);
  const PUNE = "fac-amc-pune";

  // 1. A patient: no record reaches the provider; identifiers masked; logged without text.
  const a = await patientWithPerson("a", PUNE);
  await prisma.person.update({ where: { id: a.personId }, data: { dataClassification: "SYNTHETIC" } });
  const allergies = (await prisma.allergy.findMany({ where: { patientId: a.patient.id }, select: { substance: true } })).map((x) => x.substance);
  const marks = [a.patient.fullName, a.patient.uhid, ...allergies];
  seen.length = 0;
  const r1 = await chatGeneral({ kind: "PATIENT", userId: a.user.id }, { message: `My number is ${a.patient.phone} and ABHA 12-3456-7890-1234. What can you do?` });
  report("Patient: answered", r1.outcome === "ANSWERED", r1.outcome);
  report("Patient: the provider was called once", seen.length === 1, String(seen.length));
  report("Patient: no record reaches the provider (name, UHID, allergies)", seen.every((t) => marks.every((m) => !t.includes(m))));
  report("Patient: their phone number is masked out of the message", seen.every((t) => !t.includes(a.patient.phone!)) && seen.some((t) => t.includes("[redacted]")));
  report("Patient: an ABHA-shaped number is masked out of the message", seen.every((t) => !t.includes("12-3456-7890-1234")));
  const row = await prisma.aiInteraction.findUnique({ where: { id: r1.interactionId } });
  report("Patient: logged as ASSISTANT, with no text kept", row?.mode === "ASSISTANT" && row.personId === a.personId && !row.questionCiphertext && !row.answerCiphertext && row.patientId === null);
  report("Patient: the reply carries the advisory label", r1.label.startsWith("AI-generated"));

  // 2. Safety rules before any model.
  seen.length = 0;
  const urgent = await chatGeneral({ kind: "PATIENT", userId: a.user.id }, { message: "I have chest pain and can't breathe" });
  report("Urgent symptom: the emergency line only, no model", urgent.outcome === "REFUSED_SAFETY" && urgent.text === phrase("en", "emergency") && seen.length === 0);
  const dosing = await chatGeneral({ kind: "PATIENT", userId: a.user.id }, { message: "Should I stop my metformin?" });
  report("Dosing question: ask your care team, no model", dosing.outcome === "REFUSED_SAFETY" && dosing.text === phrase("en", "askCareTeam") && seen.length === 0);

  // 3. AI consent declined.
  const b = await patientWithPerson("b", PUNE);
  await prisma.person.update({ where: { id: b.personId }, data: { dataClassification: "SYNTHETIC" } });
  await decidePersonConsent({ userId: b.user.id, purpose: "AI_ASSISTANCE", decision: "DECLINED" });
  seen.length = 0;
  const declined = await outcome(chatGeneral({ kind: "PATIENT", userId: b.user.id }, { message: "hello" }));
  report("AI consent declined: 403, no model", declined === "403 AI_AI_DECLINED" && seen.length === 0, declined);

  // 4. A REAL Person.
  const c = await patientWithPerson("c", PUNE);
  await prisma.person.update({ where: { id: c.personId }, data: { dataClassification: "REAL" } });
  const prevSwitch = process.env.AI_REAL_DATA_ENABLED;
  delete process.env.AI_REAL_DATA_ENABLED;
  seen.length = 0;
  const real = await outcome(chatGeneral({ kind: "PATIENT", userId: c.user.id }, { message: "hello" }));
  report("REAL Person, switch off: 403, no model", real === "403 AI_REAL_DATA_DISABLED" && seen.length === 0, real);
  process.env.AI_REAL_DATA_ENABLED = "true";
  delete process.env.AI_PHI_ALLOWED_ANTHROPIC;
  await decidePersonConsent({ userId: c.user.id, purpose: "AI_ASSISTANCE", decision: "GRANTED" });
  const anthropic = new AnthropicAIProvider("sk-ant-not-a-real-key");
  const policy = await anthropic.assistantReply({ audience: "patient", message: "hello" }, issueAssistantPermit(true)).then(() => "sent", (e: Error) => e.message);
  report("Switch on, consent granted, provider flag off: Anthropic refuses before any network call", policy === "DATA_POLICY", policy);
  if (prevSwitch === undefined) delete process.env.AI_REAL_DATA_ENABLED; else process.env.AI_REAL_DATA_ENABLED = prevSwitch;

  // 5. A login with no Person.
  const orphan = await prisma.user.create({ data: { email: `ai-assistant-orphan-${randomUUID().slice(0, 8)}@verify.aarogya`, displayName: "No person", role: Role.PATIENT, passwordHash: "x" } });
  seen.length = 0;
  const noPerson = await outcome(chatGeneral({ kind: "PATIENT", userId: orphan.id }, { message: "hello" }));
  report("A login with no Person: refused, no model", noPerson.startsWith("403 AI_") && seen.length === 0, noPerson);

  // 6. Staff naming a patient: the record gateway.
  const staff = async (role: Role, facilityId: string) => {
    const p = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { department: { facilityId }, user: { role } }, orderBy: { id: "asc" }, select: { userId: true } });
    return { kind: "STAFF" as const, userId: p.userId, role, facilityId };
  };
  seen.length = 0;
  const noidaDoctor = await staff(Role.DOCTOR, "fac-amc-noida");
  const cross = await outcome(chatAboutRecord(noidaDoctor, { patientId: a.patient.id, message: "What are the allergies?" }));
  report("Another facility's patient: 404", cross === "404 NOT_FOUND", cross);
  // Nurses have no department; the seeded Pune nurse is found by login.
  const nurse = { kind: "STAFF" as const, userId: (await prisma.user.findUniqueOrThrow({ where: { email: "nurse1@amc-demo.aarogya" }, select: { id: true } })).id, role: Role.NURSE, facilityId: PUNE };
  const unassigned = await outcome(chatAboutRecord(nurse, { patientId: a.patient.id, message: "What are the allergies?" }));
  report("A nurse's unassigned patient: 404", unassigned === "404 NOT_FOUND", unassigned);
  report("Record questions never reach the record-free assistant", seen.length === 0, String(seen.length));

  // 7. AI off at the facility: Noida's published ai.enabled is retired for the check, then restored.
  const noidaOn = await prisma.configurationOverride.findMany({ where: { facilityId: "fac-amc-noida", key: "ai.enabled", status: "PUBLISHED" }, select: { id: true } });
  await prisma.configurationOverride.updateMany({ where: { id: { in: noidaOn.map((o) => o.id) } }, data: { status: "RETIRED" } });
  seen.length = 0;
  const off = await outcome(chatGeneral(noidaDoctor, { message: "hello" }));
  await prisma.configurationOverride.updateMany({ where: { id: { in: noidaOn.map((o) => o.id) } }, data: { status: "PUBLISHED" } });
  report("Staff where the AI is off: 403, no model", noidaOn.length > 0 && off === "403 AI_NOT_ENABLED" && seen.length === 0, off);

  // 8. Scholar: record-free.
  const student = await prisma.user.findFirstOrThrow({ where: { role: Role.STUDENT }, orderBy: { id: "asc" }, select: { id: true } });
  seen.length = 0;
  const s = await chatGeneral({ kind: "OTHER", userId: student.id, role: Role.STUDENT }, { message: "Explain the Glasgow coma scale" });
  const srow = await prisma.aiInteraction.findUnique({ where: { id: s.interactionId } });
  report("Scholar: answered record-free, logged with no person, patient or facility", s.outcome === "ANSWERED" && !!srow && srow.personId === null && srow.patientId === null && srow.facilityId === null);

  // 9. Rate limits on the interaction log.
  const d = await patientWithPerson("d", PUNE);
  await prisma.person.update({ where: { id: d.personId }, data: { dataClassification: "SYNTHETIC" } });
  const results: string[] = [];
  for (let i = 0; i < 7; i++) results.push(await outcome(chatGeneral({ kind: "PATIENT", userId: d.user.id }, { message: `question ${i}` })));
  report("Patient: six a minute, the seventh is 429", results.slice(0, 6).every((x) => x === "ANSWERED") && results[6] === "429 RATE_LIMITED", results.join(","));

  // 10. Parity with /api/ai/ask (RAG Phase 5, 5.7).
  const doc = await staff(Role.DOCTOR, PUNE);
  const e = await patientWithPerson("e", PUNE);
  await prisma.person.update({ where: { id: e.personId }, data: { dataClassification: "SYNTHETIC" } });
  const docStaff = await prisma.hospitalStaffProfile.findUniqueOrThrow({ where: { userId: doc.userId }, select: { id: true } });
  const enc = await prisma.encounter.create({ data: { patientId: e.patient.id, facilityId: PUNE, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "assistant parity", attendingStaffId: docStaff.id } });
  await prisma.clinicalNote.create({ data: { encounterId: enc.id, authorStaffId: docStaff.id, authorRole: "DOCTOR", type: "PROGRESS", status: "SIGNED", content: { subjective: "Dizziness on standing for two days.", plan: "Orthostatic vitals; review in clinic." } } }).catch(() => null);
  const o = await prisma.labOrder.create({ data: { encounterId: enc.id, patientId: e.patient.id, testName: "Serum sodium", category: "Biochemistry", orderedByStaffId: docStaff.id } });
  const lr = await prisma.labResult.create({ data: { labOrderId: o.id, value: "129", unit: "mEq/L", abnormalFlag: "LOW", status: "VERIFIED", resultedAt: new Date("2026-10-05T08:00:00Z") } });
  const { emitFacilityEvent } = await import("../src/lib/events/facilityEvent");
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LabResultReleased", aggregateId: lr.id, facilityId: PUNE, payload: { resultId: lr.id, orderId: o.id, patientId: e.patient.id } }));
  registerAllConsumers();
  for (let i = 0; i < 20; i++) if ((await dispatchPendingDomainEvents({ now: new Date(), batchSize: 500, maxDurationMs: 60_000 })).claimed === 0) break;
  const recordMock = getRecordAnswerProvider({});
  const given: AnswerRequest[] = [];
  let invent = false;
  const spy: RecordAnswerProvider = { id: "mock", async answerFromRecord(req, permit) {
    given.push(req);
    const a = await recordMock.answerFromRecord(req, permit);
    return invent ? { ...a, sentences: a.sentences.map((x, i) => (i === a.sentences.length - 1 && x.kind === "FACT" ? { ...x, text: `${x.text} Sodium 141 mEq/L.` } : x)) } : a;
  } };
  setRecordAnswerProviderForTest(spy);
  const Q = `Did ${e.patient.fullName} have a low sodium, and what was the plan?`;
  const cool = () => prisma.$executeRaw`UPDATE "AiInteraction" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "userId" = ${doc.userId} AND "createdAt" > now() - interval '2 minutes'`;
  await cool();
  const viaChat = await chatAboutRecord(doc, { patientId: e.patient.id, message: Q });
  await cool();
  const viaAsk = await askAi(doc, { mode: "CHART_QA", patientId: e.patient.id, question: Q });
  const [rc, ra] = await Promise.all([viaChat, viaAsk].map((r) => prisma.aiInteraction.findUniqueOrThrow({ where: { id: "interactionId" in r ? r.interactionId : r.meta.interactionId } })));
  report("Parity: the same outcome and the same cited sources through /api/chat and /api/ai/ask", viaChat.outcome === viaAsk.outcome && viaAsk.outcome === "ANSWERED" && JSON.stringify(viaChat.citations.map((c) => c.sourceId).sort()) === JSON.stringify(viaAsk.citations.map((c) => c.sourceId).sort()), `${viaChat.outcome} / ${viaAsk.outcome}`);
  report("Parity: the same masking (the patient's name never reaches the answer provider on either path)",
    given.length === 2 && given.every((g) => !JSON.stringify(g).includes(e.patient.fullName) && g.question?.includes("[redacted]")) && given[0].question === given[1].question);
  report("Parity: the same log (CHART_QA; the same sources retrieved and cited; the text kept the same way); the module CHAT or ASK",
    rc.mode === "CHART_QA" && ra.mode === "CHART_QA" && rc.module === "CHAT" && ra.module === "ASK" && JSON.stringify([...rc.retrievedChunkIds].sort()) === JSON.stringify([...ra.retrievedChunkIds].sort())
      && JSON.stringify([...rc.citedChunkIds].sort()) === JSON.stringify([...ra.citedChunkIds].sort()) && rc.textScope === ra.textScope && !!rc.questionCiphertext === !!ra.questionCiphertext && rc.tier === ra.tier);
  invent = true;
  await cool();
  const badChat = await chatAboutRecord(doc, { patientId: e.patient.id, message: Q });
  await cool();
  const badAsk = await askAi(doc, { mode: "CHART_QA", patientId: e.patient.id, question: Q });
  invent = false;
  report("Parity: the same validation (an invented number ends CITATION_INVALID on both paths)", badChat.outcome === "CITATION_INVALID" && badAsk.outcome === "CITATION_INVALID", `${badChat.outcome} / ${badAsk.outcome}`);
  const crossAsk = await outcome(askAi(noidaDoctor, { mode: "CHART_QA", patientId: e.patient.id, question: Q }));
  const crossChat = await outcome(chatAboutRecord(noidaDoctor, { patientId: e.patient.id, message: Q }));
  report("Parity: the same access result (another facility's doctor: 404 on both)", crossAsk === "404 NOT_FOUND" && crossChat === crossAsk, `${crossChat} / ${crossAsk}`);
  setRecordAnswerProviderForTest(null);

  // 11. Knowledge and live-state questions from the chat go to their own gateways.
  seen.length = 0;
  await cool();
  const kq = "What is our hand hygiene policy for alcohol rub?";
  const kChat = await chatStaff(doc, { message: kq });
  await cool();
  const kDirect = await askKnowledge(doc, { question: kq });
  const kRow = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: kChat.interactionId } });
  await cool();
  const oChat = await chatStaff(doc, { message: "How many beds are free?" });
  await cool();
  const oDirect = await askOps(doc, { question: "How many beds are free?" });
  const oRow = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: oChat.interactionId } });
  report("Chat: a question about the hospital's documents or live state goes to the knowledge or operational gateway, never the record-free assistant",
    seen.length === 0 && kRow.mode === "KNOWLEDGE_QA" && kRow.module === "CHAT" && kChat.outcome === kDirect.outcome && oRow.mode === "OPS_QA" && oRow.module === "CHAT" && oChat.outcome === oDirect.outcome && oChat.outcome === "ANSWERED",
    `knowledge ${kChat.outcome}/${kDirect.outcome}, ops ${oChat.outcome}/${oDirect.outcome}, assistant calls ${seen.length}`);

  setAIProviderForTest(null);
  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
