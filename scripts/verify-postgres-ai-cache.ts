/**
 * RAG Phase 4, step 4.4 — the caches (docs/RAG_ARCHITECTURE.md §14;
 * docs/RAG_IMPLEMENTATION_PLAN.md §6). Synthetic documents and patient, mock
 * providers.
 *
 *   C1  a patient-mode question never creates a cache row (embedding or
 *       retrieval), and no patient request records a cache hit
 *   C2  a cache row holds no text: the tables have no text column, and no
 *       row's values contain the question or a passage
 *   C3  an embedding cache hit returns the identical vector
 *   C4  the same user asking again hits the retrieval cache, with the same
 *       citations
 *   C5  it never crosses users (same facility and role), facilities (same
 *       organisation and role) or organisations
 *   C6  a permission change (the user's role, so their access classes)
 *       misses; so do a withdrawal (the passage is gone), an expired row, and
 *       a row tampered to name another organisation's passage (dropped, never
 *       returned)
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { createNote } from "../src/lib/hospital/clinicalNote";
import { approveKnowledgeVersion, uploadKnowledge, withdrawKnowledgeVersion, type KnowledgeActor } from "../src/lib/knowledge/service";
import { ingestKnowledgeVersion } from "../src/lib/knowledge/ingest";
import { askKnowledge } from "../src/lib/rag/knowledgeAsk";
import { askAi, type AskResult } from "../src/lib/rag/ask";
import { cachedKnowledgeEmbeddings } from "../src/lib/rag/embedCache";
import { activeSpace } from "../src/lib/rag/embed";
import { knowledgePermit } from "../src/lib/ai/realData";
import { setRecordAnswerProviderForTest } from "../src/lib/ai/record";
import type { AiActor } from "../src/lib/rag/access";
import { ensureConfigSeed } from "../src/lib/config/seed";
import { NOIDA, PUNE, staffUser } from "./lib/knowledgeGate";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const tag = Date.now().toString(36).replace(/[^a-z0-9]/g, "");
const canary = (k: string) => `cg${k}${tag}`;
let clock = Date.now();
async function drain() {
  registerAllConsumers();
  for (let i = 0; i < 40; i++) {
    clock += 2 * 3_600_000;
    if ((await dispatchPendingDomainEvents({ now: new Date(clock), batchSize: 500, maxDurationMs: 60_000 })).claimed === 0) return;
  }
}
const cool = (userId: string) => prisma.$executeRaw`UPDATE "AiInteraction" SET "createdAt" = "createdAt" - interval '2 minutes', "textExpiresAt" = "textExpiresAt" - interval '2 minutes' WHERE "userId" = ${userId} AND "createdAt" > now() - interval '2 minutes'`;
const staffActor = (a: KnowledgeActor, role = a.role): Extract<AiActor, { kind: "STAFF" }> => ({ kind: "STAFF", userId: a.userId, role, facilityId: a.facilityId });
const counts = async () => ({ emb: await prisma.aiEmbeddingCache.count(), ret: await prisma.aiRetrievalCache.count(), hits: (await prisma.aiRetrievalCache.aggregate({ _sum: { hits: true } }))._sum.hits ?? 0 });
const rowOf = (r: AskResult) => prisma.aiInteraction.findUniqueOrThrow({ where: { id: r.meta.interactionId } });

async function main() {
  registerAllConsumers();
  setRecordAnswerProviderForTest(null);
  const admin = await staffUser(`cg-admin-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", PUNE, { orgAdmin: true });
  const superintendent = await staffUser(`cg-super-${tag}@verify.aarogya`, "MEDICAL_SUPERINTENDENT", PUNE);
  const doctor = await staffUser(`cg-doctor-${tag}@verify.aarogya`, "DOCTOR", PUNE);
  const doctor2 = await staffUser(`cg-doctor2-${tag}@verify.aarogya`, "DOCTOR", PUNE);
  const noidaDoctor = await staffUser(`cg-noida-doctor-${tag}@verify.aarogya`, "DOCTOR", NOIDA);
  const otherOrg = await prisma.organization.create({ data: { name: `Cache gate network ${tag}` } });
  const otherFac = await prisma.facility.create({ data: { name: `Cache gate hospital ${tag}`, organizationId: otherOrg.id, dataClassification: "SYNTHETIC" } });
  const otherAdmin = await staffUser(`cg-other-admin-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", otherFac.id);
  const otherSuper = await staffUser(`cg-other-super-${tag}@verify.aarogya`, "MEDICAL_SUPERINTENDENT", otherFac.id);
  const otherDoctor = await staffUser(`cg-other-doctor-${tag}@verify.aarogya`, "DOCTOR", otherFac.id);
  // The AI switch on at the other organisation's synthetic facility, as the seed does for the demo ones.
  const platform = await prisma.user.findFirstOrThrow({ where: { role: "AAROGYA_ADMIN" }, select: { id: true } });
  await ensureConfigSeed(platform.id, otherOrg.id);
  const publish = async (up: KnowledgeActor, ap: KnowledgeActor, title: string, body: string, opts: { accessClass?: string; scope?: "FACILITY" | "ORGANIZATION" } = {}) => {
    const u = await uploadKnowledge(up, { title: `${title} ${tag}`, documentType: "SOP", accessClass: opts.accessClass ?? "CLINICAL", scope: opts.scope, fileName: `${title.replace(/\s/g, "-")}-${tag}.md`, declaredType: "text/markdown", bytes: Buffer.from(body, "utf8") });
    await ingestKnowledgeVersion(u.versionId);
    await approveKnowledgeVersion(ap, u.versionId);
    return u;
  };
  // Pharmacy text a doctor reads (PHARMACY) and a nurse doesn't, in an organisation-wide document every Pune and Noida doctor reads.
  // It states the question's own words, so it is found on a fresh database as on a full one (no other document needed).
  const insulin = await publish(admin, superintendent, "Insulin storage gate", `# Insulin storage\n\nHow should unopened insulin pens be stored? Store unopened insulin pens at 2 to 8 °C. ${canary("pharm")}.\n`, { accessClass: "PHARMACY", scope: "ORGANIZATION" });
  await publish(otherAdmin, otherSuper, "Insulin storage other", `# Insulin storage\n\nHow should unopened insulin pens be stored? Store unopened insulin pens at 2 to 8 °C. ${canary("other")}.\n`, { accessClass: "PHARMACY" });
  // A patient whose doctor asks a chart question.
  const reg = await registerPatientAccount({ facilityId: PUNE, fullName: `Cache Gate ${tag}`, email: `cg-pt-${tag}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1980-01-01") });
  if (reg.status !== "LINKED_NEW") throw new Error("fixture patient");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: reg.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC" } });
  const patientId = (await prisma.personPatientLink.findFirstOrThrow({ where: { personId, status: "ACTIVE" } })).patientId;
  const enc = await prisma.encounter.create({ data: { patientId, facilityId: PUNE, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "cache gate" } });
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: PUNE }, select: { id: true } });
  const chartUser = await prisma.user.create({ data: { email: `cg-chart-${tag}@verify.aarogya`, passwordHash: "x", role: "DOCTOR", displayName: "Cache gate chart" } });
  const chartStaff = await prisma.hospitalStaffProfile.create({ data: { userId: chartUser.id, departmentId: dept.id, displayRole: "Physician" } });
  await createNote({ encounterId: enc.id, authorStaffId: chartStaff.id, authorRole: "DOCTOR", type: "PROGRESS", content: { subjective: `Insulin storage at home discussed. ${canary("patient")}.` }, sign: true, byUserId: chartUser.id });
  await drain();
  const ask = async (a: KnowledgeActor, q: string, role = a.role) => { await cool(a.userId); return askKnowledge(staffActor(a, role), { question: q }); };
  const question = `How should unopened insulin pens be stored? ${canary("pharm")}`;

  // ── C1: patient mode ──
  const before = await counts();
  await cool(chartUser.id);
  const chart = await askAi({ kind: "STAFF", userId: chartUser.id, role: "DOCTOR", facilityId: PUNE }, { mode: "CHART_QA", patientId, question: `insulin storage ${canary("patient")}` });
  await cool(chartUser.id);
  await askAi({ kind: "STAFF", userId: chartUser.id, role: "DOCTOR", facilityId: PUNE }, { mode: "CHART_QA", patientId, question: `insulin storage ${canary("patient")}` });
  const afterChart = await counts();
  report("C1: patient-mode questions (asked twice) create no embedding or retrieval cache row", afterChart.emb === before.emb && afterChart.ret === before.ret, `${before.emb}→${afterChart.emb}, ${before.ret}→${afterChart.ret}`);
  report("C1 control: the chart question was answered from the record", chart.outcome === "ANSWERED", chart.outcome);
  const patientHits = await prisma.aiInteraction.count({ where: { mode: { not: "KNOWLEDGE_QA" }, cacheHits: { gt: 0 } } });
  report("C1: no patient-mode interaction anywhere records a cache hit", patientHits === 0, String(patientHits));

  // ── C4, C2 ──
  const first = await ask(doctor, question);
  const mid = await counts();
  const second = await ask(doctor, question);
  const end = await counts();
  const [r1, r2] = [await rowOf(first), await rowOf(second)];
  report("C4 control: the first ask is answered from the PHARMACY document and writes one retrieval cache row", first.outcome === "ANSWERED" && JSON.stringify(first.sentences).includes(canary("pharm")) && mid.ret === afterChart.ret + 1, `${first.outcome}, rows ${afterChart.ret}→${mid.ret}`);
  report("C4: the same user asking again hits the retrieval cache, embeds nothing, and cites the same passages",
    end.hits === mid.hits + 1 && r2.cacheHits >= 1 && r2.embeddingTokens === 0 && JSON.stringify(second.citations.map((c) => c.chunkId)) === JSON.stringify(first.citations.map((c) => c.chunkId)), `hits ${mid.hits}→${end.hits}, cacheHits ${r1.cacheHits}/${r2.cacheHits}`);
  const cols = await prisma.$queryRaw<{ table_name: string; column_name: string; udt_name: string }[]>`SELECT table_name, column_name, udt_name FROM information_schema.columns WHERE table_name IN ('AiEmbeddingCache', 'AiRetrievalCache')`;
  const allowed = new Set(["id", "embeddingModel", "contentHash", "keyHash", "organizationId", "facilityId", "userId", "chunkIds"]);
  report("C2: the cache tables have no column for text (ids, hashes, vectors, scores, counts and times only)", cols.filter((c) => ["text", "varchar", "_text", "_varchar"].includes(c.udt_name)).every((c) => allowed.has(c.column_name)), cols.filter((c) => ["text", "varchar", "_text"].includes(c.udt_name) && !allowed.has(c.column_name)).map((c) => c.column_name).join() || `${cols.length} columns`);
  const dump = JSON.stringify(await prisma.aiRetrievalCache.findMany()) + JSON.stringify(await prisma.$queryRaw`SELECT "id", "embeddingModel", "contentHash" FROM "AiEmbeddingCache"`);
  report("C2: no cache row contains the question, a passage or a canary", !dump.includes(canary("pharm")) && !dump.toLowerCase().includes("insulin") && !dump.includes(canary("patient")));

  // ── C3 ──
  const space = await activeSpace();
  const e1 = await cachedKnowledgeEmbeddings(space, [`cache gate vector ${tag}`], knowledgePermit(admin.organizationId));
  const e2 = await cachedKnowledgeEmbeddings(space, [`cache gate vector ${tag}`], knowledgePermit(admin.organizationId));
  // Stored as halfvec: the hit is the stored vector, identical on every read, and the fresh vector at half precision.
  const e3 = await cachedKnowledgeEmbeddings(space, [`cache gate vector ${tag}`], knowledgePermit(admin.organizationId));
  report("C3: an embedding cache hit returns the identical vector", e1.embedded === 1 && e2.hits === 1 && e2.embedded === 0 && JSON.stringify(e2.vectors) === JSON.stringify(e3.vectors) && e1.vectors[0].every((x, i) => Math.abs(x - e2.vectors[0][i]) < 1e-3), `embedded ${e1.embedded}, hit ${e2.hits}`);

  // ── C5 ──
  const n0 = await counts();
  const other = await ask(doctor2, question);
  const n1 = await counts();
  report("C5: another user (same facility, same role) never hits the first user's row", n1.hits === n0.hits && n1.ret === n0.ret + 1 && (await rowOf(other)).embeddingTokens >= 0, `hits ${n0.hits}→${n1.hits}, rows ${n0.ret}→${n1.ret}`);
  const noida = await ask(noidaDoctor, question);
  const n2 = await counts();
  report("C5: another facility of the organisation (same role) never hits it", n2.hits === n1.hits && n2.ret === n1.ret + 1 && noida.outcome === "ANSWERED", `hits ${n1.hits}→${n2.hits}`);
  const foreign = await ask(otherDoctor, question);
  const n3 = await counts();
  report("C5: another organisation never hits it, and never sees its passage", n3.hits === n2.hits && !JSON.stringify(foreign.sentences).includes(canary("pharm")), `hits ${n2.hits}→${n3.hits}`);
  report("C5: every row is its own user's, facility's and organisation's", (await prisma.aiRetrievalCache.count({ where: { userId: doctor.userId, NOT: { facilityId: PUNE } } })) === 0 && (await prisma.aiRetrievalCache.count({ where: { userId: otherDoctor.userId, NOT: { organizationId: otherOrg.id } } })) === 0);

  // ── C6 ──
  const asNurse = await ask(doctor, question, "NURSE");
  const n4 = await counts();
  report("C6: a permission change (the role, so the access classes) misses, and the nurse's classes don't include the PHARMACY text", n4.hits === n3.hits && !JSON.stringify(asNurse.sentences).includes(canary("pharm")), `hits ${n3.hits}→${n4.hits}`);
  await ask(doctor, question); // the doctor's row again: a hit
  const n5 = await counts();
  report("C6 control: back as a doctor, the original row hits", n5.hits === n4.hits + 1);
  // A tampered row: the doctor's key now names another organisation's passage. It is dropped, never returned.
  const foreignChunk = await prisma.ragChunk.findFirstOrThrow({ where: { ownerType: "KNOWLEDGE", organizationId: otherOrg.id, text: { contains: canary("other") } }, select: { id: true } });
  await prisma.aiRetrievalCache.updateMany({ where: { userId: doctor.userId, facilityId: PUNE, hits: { gt: 0 } }, data: { chunkIds: [foreignChunk.id], scores: [0.99], topScore: 0.99 } });
  const tampered = await ask(doctor, question);
  report("C6: a cached row naming a passage outside the scope is dropped, and that passage never returned", !JSON.stringify(tampered.sentences).includes(canary("other")) && JSON.stringify(tampered.sentences).includes(canary("pharm")), tampered.outcome);
  // Expiry.
  await prisma.aiRetrievalCache.updateMany({ where: { userId: doctor.userId }, data: { expiresAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 2000) } });
  const n6 = await counts();
  await ask(doctor, question);
  const n7 = await counts();
  report("C6: an expired row is never used", n7.hits === n6.hits, `hits ${n6.hits}→${n7.hits}`);
  // Withdrawal: the set of versions in force changes, so the key does; the passage is gone.
  await withdrawKnowledgeVersion(admin, insulin.versionId, "cache gate");
  const n8 = await counts();
  const gone = await ask(doctor, question);
  const n9 = await counts();
  report("C6: after a withdrawal the cached retrieval is not used and the withdrawn passage never appears", n9.hits === n8.hits && !JSON.stringify(gone.sentences).includes(canary("pharm")), `${gone.outcome}, hits ${n8.hits}→${n9.hits}`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
