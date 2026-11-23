/**
 * RAG Phase 3, step 3.4 — knowledge Q&A and its leak canaries
 * (docs/RAG_IMPLEMENTATION_PLAN.md §5.1: "another organisation's document;
 * another facility's; a class the role lacks; an unpublished version; a
 * patient canary never appears in a knowledge answer and a knowledge request
 * never returns a patient chunk"). Synthetic documents, mock models. Every
 * absence has a positive control beside it; the mock answerer quotes its
 * sources, so anything retrieved would surface in the answer.
 *
 *   L1  another organisation's document       L5  a superseded version
 *   L2  another facility's document           L6  a patient's note, asked for by
 *   L3  a class the role lacks (ADMIN,            its canary in knowledge Q&A
 *       BILLING)                              L7  a knowledge canary asked for in
 *   L4  an unpublished (indexed, unapproved)      chart Q&A
 *       version
 * Also: an organisation-wide document reaches every facility of it; the
 * answer cites approved documents (labelled), the interaction has no patient
 * and records the version and section; "not in the documents", operational
 * and patient questions end NO_RECORD with no source; a role without
 * ai:knowledge:ask is refused; with external providers off (the default) a
 * configured real provider is never called.
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { createNote } from "../src/lib/hospital/clinicalNote";
import { approveKnowledgeVersion, uploadKnowledge, type KnowledgeActor } from "../src/lib/knowledge/service";
import { ingestKnowledgeVersion } from "../src/lib/knowledge/ingest";
import { searchKnowledge } from "../src/lib/rag/knowledgeSearch";
import { askKnowledge } from "../src/lib/rag/knowledgeAsk";
import { askAi, AskError, type AskResult } from "../src/lib/rag/ask";
import { getRecordAnswerProvider, setRecordAnswerProviderForTest, type RecordAnswerProvider } from "../src/lib/ai/record";
import type { AiActor } from "../src/lib/rag/access";
import { NOIDA, PUNE, staffUser } from "./lib/knowledgeGate";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const tag = Date.now().toString(36).replace(/[^a-z0-9]/g, "");
const canary = (k: string) => `kq${k}${tag}`;
let clock = Date.now();

async function drain() {
  registerAllConsumers();
  for (let i = 0; i < 40; i++) {
    clock += 2 * 3_600_000;
    if ((await dispatchPendingDomainEvents({ now: new Date(clock), batchSize: 500, maxDurationMs: 60_000 })).claimed === 0) return;
  }
}
const staffActor = (a: KnowledgeActor): Extract<AiActor, { kind: "STAFF" }> => ({ kind: "STAFF", userId: a.userId, role: a.role, facilityId: a.facilityId });
const cool = (userId: string) => prisma.$executeRaw`UPDATE "AiInteraction" SET "createdAt" = "createdAt" - interval '2 minutes', "textExpiresAt" = "textExpiresAt" - interval '2 minutes' WHERE "userId" = ${userId} AND "createdAt" > now() - interval '2 minutes'`;

/** Everything a request touched: the answer, its citations, and every retrieved chunk's text. */
async function touched(r: AskResult): Promise<string> {
  const row = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: r.meta.interactionId } });
  const chunks = await prisma.ragChunk.findMany({ where: { id: { in: [...row.retrievedChunkIds, ...row.citedChunkIds] } }, select: { text: true, context: true } });
  return [JSON.stringify(r.sentences), JSON.stringify(r.citations), ...chunks.map((c) => `${c.context}\n${c.text}`)].join("\n");
}

async function main() {
  registerAllConsumers();
  setRecordAnswerProviderForTest(null);
  const admin = await staffUser(`kq-admin-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", PUNE, { orgAdmin: true });
  const superintendent = await staffUser(`kq-super-${tag}@verify.aarogya`, "MEDICAL_SUPERINTENDENT", PUNE);
  const doctor = await staffUser(`kq-doctor-${tag}@verify.aarogya`, "DOCTOR", PUNE);
  const billing = await staffUser(`kq-billing-${tag}@verify.aarogya`, "BILLING_STAFF", PUNE);
  const noidaAdmin = await staffUser(`kq-noida-admin-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", NOIDA);
  const noidaSuper = await staffUser(`kq-noida-super-${tag}@verify.aarogya`, "MEDICAL_SUPERINTENDENT", NOIDA);
  const noidaDoctor = await staffUser(`kq-noida-doctor-${tag}@verify.aarogya`, "DOCTOR", NOIDA);
  // Another organisation, with a facility and its own administrator and approver.
  const otherOrg = await prisma.organization.create({ data: { name: `Other network ${tag}` } });
  const otherFac = await prisma.facility.create({ data: { name: `Other hospital ${tag}`, organizationId: otherOrg.id, dataClassification: "SYNTHETIC" } });
  const otherAdmin = await staffUser(`kq-other-admin-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", otherFac.id);
  const otherSuper = await staffUser(`kq-other-super-${tag}@verify.aarogya`, "MEDICAL_SUPERINTENDENT", otherFac.id);

  const publish = async (up: KnowledgeActor, ap: KnowledgeActor, title: string, body: string, opts: { accessClass?: string; scope?: "FACILITY" | "ORGANIZATION"; documentId?: string; approve?: boolean } = {}) => {
    const u = await uploadKnowledge(up, { title: `${title} ${tag}`, documentType: "SOP", accessClass: opts.accessClass ?? "CLINICAL", scope: opts.scope, documentId: opts.documentId, fileName: `${title.replace(/\s/g, "-")}-${tag}.md`, declaredType: "text/markdown", bytes: Buffer.from(body, "utf8") });
    await ingestKnowledgeVersion(u.versionId);
    if (opts.approve !== false) await approveKnowledgeVersion(ap, u.versionId);
    return u;
  };
  const sepsis = await publish(admin, superintendent, "Sepsis bundle", `# Sepsis bundle\n\nGive the first antibiotic dose within 1 hour of recognition. ${canary("clin")}.\n\n## Fluids\n\nGive 30 mL/kg crystalloid for hypotension.\n`);
  await publish(noidaAdmin, noidaSuper, "Noida oxygen", `# Oxygen cylinders\n\nCheck the gauge every shift. ${canary("noida")}.\n`);
  await publish(otherAdmin, otherSuper, "Other hygiene", `# Hand hygiene\n\nWash for 40 seconds. ${canary("org")}.\n`, { accessClass: "ALL_STAFF" });
  await publish(admin, superintendent, "Staff rota policy", `# Rota\n\nRotas are published two weeks ahead. ${canary("admin")}.\n`, { accessClass: "ADMIN" });
  await publish(admin, superintendent, "Billing policy", `# Billing\n\nPackage rates are revised each April. ${canary("bill")}.\n`, { accessClass: "BILLING" });
  const pending = await publish(admin, superintendent, "Transfusion draft", `# Transfusion\n\nStart within 30 minutes of issue. ${canary("pending")}.\n`, { approve: false });
  const v1 = await publish(admin, superintendent, "Falls policy", `# Falls\n\nAssess falls risk on admission. ${canary("old")}.\n`);
  await publish(admin, superintendent, "Falls policy", `# Falls\n\nAssess falls risk on admission and every shift. ${canary("new")}.\n`, { documentId: v1.documentId });
  await publish(admin, superintendent, "Group fire safety", `# Fire safety\n\nKnow the nearest exit. ${canary("orgwide")}.\n`, { accessClass: "ALL_STAFF", scope: "ORGANIZATION" });

  // A patient with a note naming a canary; the doctor treats them.
  const reg = await registerPatientAccount({ facilityId: PUNE, fullName: `Knowledge QA ${tag}`, email: `kq-pt-${tag}@verify.aarogya`, passwordHash: "x", sex: "M", dob: new Date("1970-01-01") });
  if (reg.status !== "LINKED_NEW") throw new Error("fixture patient");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: reg.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC" } });
  const patientId = (await prisma.personPatientLink.findFirstOrThrow({ where: { personId, status: "ACTIVE" } })).patientId;
  const enc = await prisma.encounter.create({ data: { patientId, facilityId: PUNE, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "knowledge gate" } });
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: PUNE }, select: { id: true } });
  const chartUser = await prisma.user.create({ data: { email: `kq-chart-${tag}@verify.aarogya`, passwordHash: "x", role: "DOCTOR", displayName: "KQ chart" } });
  const chartStaff = await prisma.hospitalStaffProfile.create({ data: { userId: chartUser.id, departmentId: dept.id, displayRole: "Physician" } });
  await createNote({ encounterId: enc.id, authorStaffId: chartStaff.id, authorRole: "DOCTOR", type: "PROGRESS", content: { subjective: `Sepsis suspected; antibiotics started. ${canary("patient")}.` }, sign: true, byUserId: chartUser.id });
  await drain();
  const chartActor: AiActor = { kind: "STAFF", userId: chartUser.id, role: "DOCTOR", facilityId: PUNE };

  const ask = async (a: KnowledgeActor, q: string) => { await cool(a.userId); return askKnowledge(staffActor(a), { question: q }); };
  const sees = async (a: KnowledgeActor, k: string, q = `${canary(k)}`) => (await touched(await ask(a, q))).includes(canary(k));

  // ── Answers cite approved documents ──
  const ok = await ask(doctor, `When should the first antibiotic dose be given in the sepsis bundle? ${canary("clin")}`);
  report("Control: the doctor's answer quotes the facility's clinical SOP", ok.outcome === "ANSWERED" && ok.sentences.some((s) => s.text.includes(canary("clin"))), ok.outcome);
  report("Answer: every fact cites an approved document and is labelled so", ok.sentences.filter((s) => s.kind === "FACT").every((s) => s.citations.length > 0 && s.labels.includes("approved document")) && ok.citations.every((c) => c.sourceType === "KNOWLEDGE_DOCUMENT"));
  const row = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: ok.meta.interactionId }, include: { sources: true } });
  report("Interaction: mode KNOWLEDGE_QA, no patient or person, sources record the version and section",
    row.mode === "KNOWLEDGE_QA" && row.patientId === null && row.personId === null && row.sources.length > 0 && row.sources.every((s) => s.sourceType === "KNOWLEDGE_DOCUMENT" && s.knowledgeVersionId && s.sourceKind === "CHUNK") && row.sources.some((s) => s.sectionPath));
  report("Interaction: the cited version is the published one", row.sources.filter((s) => s.cited).every((s) => s.knowledgeVersionId === sepsis.versionId));

  // ── L1–L5 ──
  report("L1: another organisation's document never appears", !(await sees(doctor, "org")) && !(await sees(superintendent, "org")));
  report("L1 control: it is in force for its own organisation", (await searchKnowledge({ organizationId: otherOrg.id, facilityId: otherFac.id, accessClasses: ["ALL_STAFF"] }, canary("org"))).some((h) => h.text.includes(canary("org"))));
  report("L2: another facility's document never appears (Pune never sees Noida's)", !(await sees(doctor, "noida")));
  report("L2 control: Noida's doctor sees it", await sees(noidaDoctor, "noida"));
  report("L2 control: an organisation-wide document reaches Pune and Noida", (await sees(doctor, "orgwide")) && (await sees(noidaDoctor, "orgwide")));
  report("L3: a class the role lacks (a doctor and an ADMIN document; a doctor and a BILLING one)", !(await sees(doctor, "admin")) && !(await sees(doctor, "bill")));
  report("L3 control: the superintendent reads ADMIN; billing staff read BILLING", (await sees(superintendent, "admin")) && (await sees(billing, "bill")));
  report("L3: billing staff never read a CLINICAL document", !(await sees(billing, "clin")));
  report("L4: an unpublished (indexed, unapproved) version never appears", !(await sees(doctor, "pending")) && !(await sees(superintendent, "pending")));
  await approveKnowledgeVersion(superintendent, pending.versionId);
  report("L4 control: once approved, it does", await sees(doctor, "pending"));
  report("L5: a superseded version never appears; the current one does", !(await sees(doctor, "old")) && (await sees(doctor, "new")));

  // ── L6, L7: patient and knowledge worlds never meet ──
  const kp = await ask(doctor, `sepsis antibiotics ${canary("patient")}`);
  const kpRow = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: kp.meta.interactionId } });
  const kpChunks = await prisma.ragChunk.findMany({ where: { id: { in: kpRow.retrievedChunkIds } }, select: { ownerType: true } });
  report("L6: a patient's note never appears in a knowledge answer", !(await touched(kp)).includes(canary("patient")));
  report("L6: a knowledge request retrieves knowledge chunks only", kpChunks.every((c) => c.ownerType === "KNOWLEDGE"), kpChunks.map((c) => c.ownerType).join());
  await cool(chartUser.id);
  const chart = await askAi(chartActor, { mode: "CHART_QA", patientId, question: `antibiotics ${canary("patient")}` });
  report("L6 control: the treating doctor's chart answer finds the note", (await touched(chart)).includes(canary("patient")));
  await cool(chartUser.id);
  const chartK = await askAi(chartActor, { mode: "CHART_QA", patientId, question: `sepsis bundle antibiotic dose ${canary("clin")}` });
  const chartKRow = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: chartK.meta.interactionId } });
  const chartKChunks = await prisma.ragChunk.findMany({ where: { id: { in: chartKRow.retrievedChunkIds } }, select: { ownerType: true } });
  report("L7: a knowledge canary never appears in a chart answer, and no knowledge chunk is retrieved", !(await touched(chartK)).includes(canary("clin")) && chartKChunks.every((c) => c.ownerType !== "KNOWLEDGE"));

  // ── What isn't answered here ──
  for (const [what, q] of [["not in the documents", `What is the procedure for zero-gravity surgery ${tag}?`], ["an operational question", "How many beds are free?"], ["a question about a patient", "What is this patient's potassium?"]] as const) {
    const r = await ask(doctor, q);
    const src = await prisma.aiInteractionSource.count({ where: { interactionId: r.meta.interactionId } });
    report(`Refused as NO_RECORD, nothing sourced: ${what}`, r.outcome === "NO_RECORD" && src === 0 && r.sentences.every((s) => s.kind === "GUIDANCE"), r.outcome);
  }
  const student = askKnowledge({ kind: "STAFF", userId: doctor.userId, role: "STUDENT", facilityId: PUNE }, { question: "sepsis" });
  report("A role without ai:knowledge:ask is refused (403)", await student.then(() => false, (e) => e instanceof AskError && e.status === 403));

  // ── External providers off (the default): a configured real provider is never called ──
  let calls = 0;
  const fake: RecordAnswerProvider = { id: "claude", async answerFromRecord(req, permit) { calls += 1; return getRecordAnswerProvider({}).answerFromRecord(req, permit); } };
  setRecordAnswerProviderForTest(fake);
  const ext = await ask(doctor, `first antibiotic dose sepsis ${canary("clin")}`);
  const extRow = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: ext.meta.interactionId } });
  report("External providers off: the configured provider is not called; the extractive answer is given (tier 0)", calls === 0 && ext.outcome === "ANSWERED" && extRow.provider === "extractive" && extRow.tier === 0, `${calls} calls, ${extRow.provider}`);
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
