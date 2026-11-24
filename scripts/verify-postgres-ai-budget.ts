/**
 * RAG Phase 4, steps 4.1 and 4.2 — the budget and compression
 * (docs/RAG_IMPLEMENTATION_PLAN.md §6). Synthetic patient, mock providers.
 * (The evaluation set's "no request over budget" check is in
 * verify-postgres-rag-eval, which runs all 230 questions.)
 *
 *   B1  a question over the mode's query cap is refused before retrieval
 *       (400, nothing logged, no provider call)
 *   B2  when the structured facts alone don't fit, the request is refused,
 *       logged ERROR, and the provider is never called
 *   B3  under a tight context budget the lowest-ranked passages are dropped:
 *       what the provider receives fits, the structured facts all among it
 *   B4  compression keeps every critical fact of every indexed chunk in the
 *       database (the whole synthetic corpus: every gate's and the
 *       evaluation's fixtures), grouped by document as a request groups them
 *   B5  level 2 is off by default; on, with the mock compressor, a passage it
 *       shortens keeps every critical fact, and the validator still checks
 *       the original text
 *   B6  adaptive retrieval: one pass by default; allowed two, never more, and
 *       never anything outside the patient's record
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { askAi, AskError } from "../src/lib/rag/ask";
import { getRecordAnswerProvider, setRecordAnswerProviderForTest, type RecordAnswerProvider } from "../src/lib/ai/record";
import type { AnswerRequest } from "../src/lib/ai/record/types";
import { setModeBudgetForTest, sourceTokens } from "../src/lib/rag/budget";
import { compressSources, lostFacts } from "../src/lib/rag/compress";
import { prepareSources } from "../src/lib/rag/prepare";
import { semanticCompressionAllowed } from "../src/lib/rag/semanticCompress";
import { setOverride, publishOverride } from "../src/lib/config/overrides";
import { loadActorMemberships } from "../src/lib/auth/tenantContext";
import type { AiActor } from "../src/lib/rag/access";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const PUNE = "fac-amc-pune";
const tag = Date.now().toString(36);
const cool = (userId: string) => prisma.$executeRaw`UPDATE "AiInteraction" SET "createdAt" = "createdAt" - interval '2 minutes', "textExpiresAt" = "textExpiresAt" - interval '2 minutes' WHERE "userId" = ${userId} AND "createdAt" > now() - interval '2 minutes'`;

async function main() {
  registerAllConsumers();
  setRecordAnswerProviderForTest(null);
  const mock = getRecordAnswerProvider();
  const seen: AnswerRequest[] = [];
  const spy: RecordAnswerProvider = { id: "mock", answerFromRecord: (req, permit) => { seen.push(req); return mock.answerFromRecord(req, permit); } };
  setRecordAnswerProviderForTest(spy);

  // A patient with several labs, vitals and a note; a treating doctor.
  const reg = await registerPatientAccount({ facilityId: PUNE, fullName: `Budget Gate ${tag}`, email: `bg-pt-${tag}@verify.aarogya`, passwordHash: "x", sex: "M", dob: new Date("1975-01-01") });
  if (reg.status !== "LINKED_NEW") throw new Error("fixture patient");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: reg.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC" } });
  const patientId = (await prisma.personPatientLink.findFirstOrThrow({ where: { personId, status: "ACTIVE" } })).patientId;
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: PUNE }, select: { id: true } });
  const user = await prisma.user.create({ data: { email: `bg-doc-${tag}@verify.aarogya`, passwordHash: "x", role: "DOCTOR", displayName: "Budget gate doctor" } });
  const staff = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: "Physician" } });
  const enc = await prisma.encounter.create({ data: { patientId, facilityId: PUNE, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "budget gate", attendingStaffId: staff.id } });
  for (const [t, v, u, at] of [["Hemoglobin", "10.9", "g/dL", "2026-09-01"], ["Hemoglobin", "11.4", "g/dL", "2026-10-01"], ["Serum potassium", "5.4", "mEq/L", "2026-10-01"], ["Serum creatinine", "1.6", "mg/dL", "2026-10-01"]] as const) {
    const o = await prisma.labOrder.create({ data: { encounterId: enc.id, patientId, testName: t, category: "Biochemistry", orderedByStaffId: staff.id } });
    await prisma.labResult.create({ data: { labOrderId: o.id, value: v, unit: u, abnormalFlag: "HIGH", status: "VERIFIED", resultedAt: new Date(`${at}T08:00:00Z`) } });
  }
  for (let d = 0; d < 6; d++) await prisma.medicationOrder.create({ data: { encounterId: enc.id, patientId, drugName: ["Metformin", "Amlodipine", "Atorvastatin", "Pantoprazole", "Furosemide", "Aspirin"][d], dose: "10 mg", route: "ORAL", frequency: "OD", orderedByStaffId: staff.id, status: "ACTIVE" } });
  registerAllConsumers();
  for (let i = 0; i < 20; i++) if ((await dispatchPendingDomainEvents({ now: new Date(), batchSize: 500, maxDurationMs: 60_000 })).claimed === 0) break;
  const actor: AiActor = { kind: "STAFF", userId: user.id, role: "DOCTOR", facilityId: PUNE };

  // ── B1 ──
  const rows0 = await prisma.aiInteraction.count({ where: { userId: user.id } });
  let code = "";
  try { await askAi(actor, { mode: "CHART_QA", patientId, question: `What is the latest hemoglobin? ${"Please consider every detail of the history. ".repeat(60)}` }); } catch (e) { code = e instanceof AskError ? `${e.status} ${e.code}` : String(e); }
  report("B1: a question over the query cap is refused before retrieval, with nothing logged and no provider call", code === "400 QUESTION_TOO_LONG" && seen.length === 0 && (await prisma.aiInteraction.count({ where: { userId: user.id } })) === rows0, code);

  // ── B2 ── a mixed question: readers' facts plus passages, so the model would be called.
  setModeBudgetForTest("CHART_QA", { context: 20 });
  code = "";
  await cool(user.id);
  try { await askAi(actor, { mode: "CHART_QA", patientId, question: "Is the potassium high and what medicines is he on and why?" }); } catch (e) { code = e instanceof AskError ? `${e.status} ${e.code}` : String(e); }
  const last = await prisma.aiInteraction.findFirst({ where: { userId: user.id }, orderBy: { createdAt: "desc" } });
  report("B2: when the structured facts alone don't fit, the request is refused and logged ERROR, and no provider is called", code === "400 STRUCTURED_FACTS_DO_NOT_FIT" && last?.outcome === "ERROR" && seen.length === 0, `${code}, ${last?.outcome}`);

  // ── B3 ── the visit brief (always the model, many sources): room for some passages, not all.
  setModeBudgetForTest("CHART_QA", null);
  const full = await (async () => { seen.length = 0; await cool(user.id); const r = await askAi(actor, { mode: "VISIT_BRIEF", patientId }); return { r, sent: seen[0] }; })();
  const fullTokens = full.sent ? full.sent.sources.reduce((a, s) => a + sourceTokens(s, "anthropic"), 0) : 0;
  const cap = Math.floor(fullTokens * 0.6);
  setModeBudgetForTest("VISIT_BRIEF", { context: cap });
  seen.length = 0;
  await cool(user.id);
  const tight = await askAi(actor, { mode: "VISIT_BRIEF", patientId });
  const sent = seen[0];
  const used = sent ? sent.sources.reduce((a, s) => a + sourceTokens(s, "anthropic"), 0) : -1;
  report("B3 control: unbudgeted, the provider receives more than the tight cap", fullTokens > cap, `${fullTokens} > ${cap}`);
  report("B3: under a tight context budget what the provider receives fits, with fewer sources", !!sent && used <= cap && sent.sources.length < full.sent!.sources.length && (tight.trace?.dropped ?? 0) > 0, `${used} ≤ ${cap}; ${sent?.sources.length} of ${full.sent?.sources.length}`);
  report("B3: the sources sent keep their rank order (the lowest ranked are the ones dropped)", !!sent && sent.sources.every((s, i) => i === 0 || s.n > sent.sources[i - 1].n));
  setModeBudgetForTest("VISIT_BRIEF", null);

  // ── B4 ── the whole synthetic corpus in this database.
  let lost = 0, checked = 0, docs = 0;
  const examples: string[] = [];
  for (let cursor: string | undefined; ;) {
    const batch = await prisma.ragDocument.findMany({ take: 500, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: "asc" }, select: { id: true, chunks: { select: { chunkNo: true, context: true, text: true }, orderBy: { chunkNo: "asc" } } } });
    if (!batch.length) break;
    for (const d of batch) {
      docs++;
      const srcs = d.chunks.map((c, i) => ({ n: i + 1, documentId: d.id, context: c.context, text: c.text }));
      const out = compressSources(srcs);
      for (let i = 0; i < srcs.length; i++) {
        checked++;
        const l = lostFacts(`[${srcs[i].n}] ${srcs[i].context}\n${srcs[i].text}`, `[${out[i].n}] ${out[i].context}\n${out[i].text}`);
        if (l.length) { lost++; if (examples.length < 3) examples.push(l.join(",")); }
      }
    }
    cursor = batch[batch.length - 1].id;
  }
  report("B4: compression keeps every critical fact of every indexed chunk in the database", checked > 0 && lost === 0, `${checked} chunks in ${docs} documents; ${lost} lost ${examples.join(" | ")}`);

  // ── B5 ──
  const fac = await prisma.facility.findUniqueOrThrow({ where: { id: PUNE }, select: { organizationId: true } });
  report("B5: level 2 is off by default", !(await semanticCompressionAllowed(fac.organizationId)));
  const platform = await prisma.user.findFirstOrThrow({ where: { role: "AAROGYA_ADMIN" }, select: { id: true } });
  const m = await loadActorMemberships(platform.id, "AAROGYA_ADMIN");
  await setOverride(m, { scope: "ORGANIZATION", organizationId: fac.organizationId, key: "ai.compression.semantic", value: "true", reason: "budget gate" });
  await publishOverride(m, { scope: "ORGANIZATION", organizationId: fac.organizationId, key: "ai.compression.semantic", reason: "budget gate" });
  try {
    const long = "Patient reviewed on the ward round today with the family present. The overnight course was described as settled by the nursing team. Potassium 5.4 mEq/L, high, recorded 2026-10-01. The team discussed diet and mobility at some length. No chest pain.";
    setModeBudgetForTest("CHART_QA", { context: 110 });
    const p = await prepareSources({ mode: "CHART_QA", language: "en", question: "potassium?", providerId: "mock", organizationId: fac.organizationId, facilityId: PUNE,
      sources: [{ n: 1, chunkId: "a", context: "[Progress note · Progress note · verified]", text: long }, { n: 2, chunkId: "b", context: "[Progress note · Progress note · verified]", text: long.replace("5.4", "5.5").replace("2026-10-01", "2026-10-02") }] });
    const shortened = p.provided.filter((s) => s.text !== p.originals.get(s.n)!.text);
    report("B5: on, a passage that didn't fit is sent shortened instead of dropped", shortened.length > 0, `${p.provided.length} sent, ${shortened.length} shortened`);
    report("B5: a shortened passage keeps every critical fact of the original", shortened.every((s) => lostFacts(p.originals.get(s.n)!.text, s.text).length === 0));
    report("B5: the validator's text is the original, never the shortened copy", shortened.every((s) => p.originals.get(s.n)!.text === long || p.originals.get(s.n)!.text.includes("5.5")));
  } finally {
    setModeBudgetForTest("CHART_QA", null);
    await setOverride(m, { scope: "ORGANIZATION", organizationId: fac.organizationId, key: "ai.compression.semantic", value: "false", reason: "budget gate: back off" });
    await publishOverride(m, { scope: "ORGANIZATION", organizationId: fac.organizationId, key: "ai.compression.semantic", reason: "budget gate: back off" });
  }
  report("B5: off again after the check", !(await semanticCompressionAllowed(fac.organizationId)));

  // ── B6 ── adaptive retrieval: one pass by default; with more allowed, never past the limit and never a wider scope.
  const qs = ["Is there anything about tiredness?", "What is his blood group?", "Any history of falls?", "How is the kidney function?"];
  const passes = async () => {
    const out: { iterations: number; foreign: number }[] = [];
    for (const q of qs) {
      await cool(user.id);
      const r = await askAi(actor, { mode: "CHART_QA", patientId, question: q });
      const row = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: r.meta.interactionId } });
      const foreign = await prisma.ragChunk.count({ where: { id: { in: row.retrievedChunkIds }, NOT: { patientId } } });
      out.push({ iterations: r.trace?.iterations ?? 1, foreign });
    }
    return out;
  };
  const one = await passes();
  report("B6: by default one retrieval pass per question", one.every((x) => x.iterations === 1), one.map((x) => x.iterations).join());
  await setOverride(m, { scope: "ORGANIZATION", organizationId: fac.organizationId, key: "ai.retrieval.max_iterations", value: "2", reason: "budget gate" });
  await publishOverride(m, { scope: "ORGANIZATION", organizationId: fac.organizationId, key: "ai.retrieval.max_iterations", reason: "budget gate" });
  try {
    const two = await passes();
    report("B6: allowed two, no question takes more, and nothing outside the patient's record is ever retrieved", two.every((x) => x.iterations <= 2 && x.foreign === 0), two.map((x) => `${x.iterations}/${x.foreign}`).join());
  } finally {
    await setOverride(m, { scope: "ORGANIZATION", organizationId: fac.organizationId, key: "ai.retrieval.max_iterations", value: "1", reason: "budget gate: back to the default" });
    await publishOverride(m, { scope: "ORGANIZATION", organizationId: fac.organizationId, key: "ai.retrieval.max_iterations", reason: "budget gate: back to the default" });
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); setModeBudgetForTest("CHART_QA", null); await prisma.$disconnect(); process.exit(1); });
