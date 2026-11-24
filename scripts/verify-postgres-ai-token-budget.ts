/**
 * RAG Phase 5, step 3f — the daily token budget per facility
 * (src/lib/rag/tokenBudget.ts). Synthetic patient, mock providers, the Noida
 * facility (its AI rows in the window are moved back first, so the count
 * starts from this gate's own requests; its budget override is reset at the
 * end).
 *
 *   T1  the budget is the facility's: its hospital administrator sets it
 *       through the configuration API (drafted, published, in the change
 *       ledger and the audit log); a doctor of the facility cannot
 *   T2  under 80%: no alert
 *   T3  crossing 80%: one AiTokenBudgetThresholdReached event (level 80) and
 *       a notification to the facility's administrator, counts only
 *   T4  still over 80% on the next request: no second 80% alert; at 100%,
 *       one level-100 alert, never repeated
 *   T5  at 100% a request that needs the model is refused: 429
 *       FACILITY_TOKEN_BUDGET with its message, logged RATE_LIMITED, and the
 *       provider is never called
 *   T6  at 100% a Tier 0 answer from the structured records is still given
 *   T7  at 100% a knowledge question that needs the model is refused too
 *   T8  another facility's requests are untouched
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { askAi, AskError } from "../src/lib/rag/ask";
import { askKnowledge } from "../src/lib/rag/knowledgeAsk";
import { getRecordAnswerProvider, setRecordAnswerProviderForTest, type RecordAnswerProvider } from "../src/lib/ai/record";
import { setOverride, publishOverride, resetOverride } from "../src/lib/config/overrides";
import { loadActorMemberships } from "../src/lib/auth/tenantContext";
import { approveKnowledgeVersion, uploadKnowledge } from "../src/lib/knowledge/service";
import { ingestKnowledgeVersion } from "../src/lib/knowledge/ingest";
import { checkTokenBudgetAlerts, facilityTokensUsed, TOKEN_BUDGET_KEY, TOKEN_BUDGET_MESSAGE } from "../src/lib/rag/tokenBudget";
import { staffUser } from "./lib/knowledgeGate";
import type { AiActor } from "../src/lib/rag/access";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const NOIDA = "fac-amc-noida";
const PUNE = "fac-amc-pune";
const tag = Date.now().toString(36);
let started = new Date();

async function drain() {
  registerAllConsumers();
  for (let i = 0; i < 20; i++) if ((await dispatchPendingDomainEvents({ now: new Date(), batchSize: 500, maxDurationMs: 60_000 })).claimed === 0) break;
}

async function doctorWithPatient(facilityId: string, name: string): Promise<{ actor: AiActor; patientId: string }> {
  const reg = await registerPatientAccount({ facilityId, fullName: `${name} ${tag}`, email: `tb-pt-${facilityId}-${tag}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1970-02-02") });
  if (reg.status !== "LINKED_NEW") throw new Error("fixture patient");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: reg.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC" } });
  const patientId = (await prisma.personPatientLink.findFirstOrThrow({ where: { personId, status: "ACTIVE" } })).patientId;
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId }, select: { id: true } });
  const user = await prisma.user.create({ data: { email: `tb-doc-${facilityId}-${tag}@verify.aarogya`, passwordHash: "x", role: "DOCTOR", displayName: "Token budget gate doctor" } });
  const staff = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: "Physician" } });
  await prisma.facilityMembership.create({ data: { userId: user.id, facilityId, isAdmin: false } });
  const enc = await prisma.encounter.create({ data: { patientId, facilityId, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "token budget gate", attendingStaffId: staff.id } });
  for (const [t, v, u] of [["Hemoglobin", "10.4", "g/dL"], ["Serum potassium", "5.2", "mEq/L"]] as const) {
    const o = await prisma.labOrder.create({ data: { encounterId: enc.id, patientId, testName: t, category: "Biochemistry", orderedByStaffId: staff.id } });
    await prisma.labResult.create({ data: { labOrderId: o.id, value: v, unit: u, abnormalFlag: "HIGH", status: "VERIFIED", resultedAt: new Date("2026-10-01T08:00:00Z") } });
  }
  await prisma.medicationOrder.create({ data: { encounterId: enc.id, patientId, drugName: "Metformin", dose: "500 mg", route: "ORAL", frequency: "BD", orderedByStaffId: staff.id, status: "ACTIVE" } });
  return { actor: { kind: "STAFF", userId: user.id, role: "DOCTOR", facilityId }, patientId };
}

async function main() {
  registerAllConsumers();
  setRecordAnswerProviderForTest(null);
  const mock = getRecordAnswerProvider();
  let calls = 0;
  const spy: RecordAnswerProvider = { id: "mock", answerFromRecord: (req, permit) => { calls += 1; return mock.answerFromRecord(req, permit); } };
  setRecordAnswerProviderForTest(spy);

  const noida = await doctorWithPatient(NOIDA, "Budget Noida");
  const pune = await doctorWithPatient(PUNE, "Budget Pune");
  const admin = await staffUser(`tb-admin-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", NOIDA);
  const superintendent = await staffUser(`tb-super-${tag}@verify.aarogya`, "MEDICAL_SUPERINTENDENT", NOIDA);
  const k = await uploadKnowledge(admin, { title: `Token budget SOP ${tag}`, documentType: "SOP", accessClass: "CLINICAL", scope: "FACILITY", fileName: `tb-sop-${tag}.md`, declaredType: "text/markdown", bytes: Buffer.from(`# Wound dressing ${tag}\n\nChange a soiled wound dressing every 24 hours using sterile gauze.\n`, "utf8") });
  await ingestKnowledgeVersion(k.versionId);
  await approveKnowledgeVersion(superintendent, k.versionId);
  await drain();
  // The window starts empty for Noida: earlier gates' rows move back past it.
  await prisma.$executeRaw`UPDATE "AiInteraction" SET "createdAt" = "createdAt" - interval '25 hours', "textExpiresAt" = "textExpiresAt" - interval '25 hours' WHERE "facilityId" = ${NOIDA} AND "createdAt" > now() - interval '25 hours'`;
  // …and so do the alerts an earlier run of this gate raised (an alert is raised once per facility per 24 hours).
  await prisma.$executeRaw`UPDATE "DomainEventOutbox" SET "occurredAt" = "occurredAt" - interval '25 hours' WHERE "eventType" = 'AiTokenBudgetThresholdReached' AND "facilityId" = ${NOIDA} AND "occurredAt" > now() - interval '25 hours'`;
  started = new Date();
  const org = (await prisma.facility.findUniqueOrThrow({ where: { id: NOIDA }, select: { organizationId: true } })).organizationId;
  const scope = { scope: "FACILITY" as const, organizationId: org, facilityId: NOIDA };
  const adminM = await loadActorMemberships(admin.userId, "HOSPITAL_ADMIN");
  const setBudget = async (n: number) => {
    await setOverride(adminM, { ...scope, key: TOKEN_BUDGET_KEY, value: String(n), reason: "token budget gate" });
    await publishOverride(adminM, { ...scope, key: TOKEN_BUDGET_KEY, reason: "token budget gate" });
  };
  const events = (level: number) => prisma.domainEventOutbox.count({ where: { eventType: "AiTokenBudgetThresholdReached", facilityId: NOIDA, occurredAt: { gte: started }, payload: { path: ["level"], equals: level } } });
  const brief = () => askAi(noida.actor, { mode: "VISIT_BRIEF", patientId: noida.patientId });
  const spread = (userId: string) => prisma.$executeRaw`UPDATE "AiInteraction" SET "createdAt" = "createdAt" - interval '2 minutes' WHERE "userId" = ${userId} AND "createdAt" > now() - interval '2 minutes'`;

  // ── T1 ──
  await setBudget(10_000_000);
  const changes = await prisma.configurationChange.count({ where: { key: TOKEN_BUDGET_KEY, scopeRef: NOIDA, actorUserId: admin.userId } });
  const audited = await prisma.auditEvent.count({ where: { type: "configuration.set", userId: admin.userId } });
  let doctorRefused = false;
  try { await setOverride(await loadActorMemberships(noida.actor.userId, "DOCTOR"), { ...scope, key: TOKEN_BUDGET_KEY, value: "1", reason: "not an admin" }); } catch { doctorRefused = true; }
  report("T1: the hospital administrator sets the facility's token budget (in the change ledger and the audit log); a doctor cannot", changes >= 2 && audited >= 1 && doctorRefused, `${changes} ledger rows, ${audited} audit rows`);

  // ── T2 ──
  const r1 = await brief();
  await spread(noida.actor.userId);
  const t = (await prisma.aiInteraction.findUniqueOrThrow({ where: { id: r1.meta.interactionId } })).inputTokens + (await prisma.aiInteraction.findUniqueOrThrow({ where: { id: r1.meta.interactionId } })).outputTokens;
  report("T2: under 80% of the budget, no alert", r1.outcome === "ANSWERED" && t > 0 && (await events(80)) === 0 && (await events(100)) === 0, `${t} tokens a brief`);

  // ── T3: a budget the next brief crosses 80% of, but not 100% ──
  const budget = Math.floor((2 * t) / 0.85);
  await setBudget(budget);
  const before = await prisma.notification.count({ where: { recipient: { userId: admin.userId }, type: "AI_TOKEN_BUDGET" } });
  const r2 = await brief();
  await spread(noida.actor.userId);
  const ev80 = await prisma.domainEventOutbox.findFirst({ where: { eventType: "AiTokenBudgetThresholdReached", facilityId: NOIDA, occurredAt: { gte: started } }, orderBy: { seq: "asc" } });
  const notes = await prisma.notification.findMany({ where: { recipient: { userId: admin.userId }, type: "AI_TOKEN_BUDGET" }, orderBy: { createdAt: "asc" } });
  const payload = (ev80?.payload ?? {}) as Record<string, unknown>;
  report("T3: crossing 80%: one level-80 event and a notification to the facility's administrator, counts only",
    r2.outcome === "ANSWERED" && (await events(80)) === 1 && notes.length === before + 1 && Object.keys(payload).sort().join(",") === "budget,level,used,windowHours" && payload.budget === budget
      && !/Budget Noida|metformin|hemoglobin/i.test(JSON.stringify(payload) + JSON.stringify(notes.map((n) => [n.title, n.body]))),
    `budget ${budget}, used ${payload.used}`);

  // ── T4 ──
  const r3 = await brief();
  await spread(noida.actor.userId);
  await checkTokenBudgetAlerts(NOIDA);
  await checkTokenBudgetAlerts(NOIDA);
  report("T4: no second 80% alert; at 100% one level-100 alert, never repeated", r3.outcome === "ANSWERED" && (await events(80)) === 1 && (await events(100)) === 1 && (await facilityTokensUsed(NOIDA)) >= budget,
    `used ${await facilityTokensUsed(NOIDA)} of ${budget}`);

  // ── T5 ──
  const callsBefore = calls;
  let code = "";
  let detail: string | undefined;
  try { await brief(); } catch (err) { if (err instanceof AskError) { code = err.code; detail = err.detail; } else throw err; }
  const refusedRow = await prisma.aiInteraction.findFirst({ where: { userId: noida.actor.userId }, orderBy: { createdAt: "desc" } });
  report("T5: at 100% a request that needs the model is refused (429 FACILITY_TOKEN_BUDGET, with its message), logged RATE_LIMITED, the provider never called",
    code === "FACILITY_TOKEN_BUDGET" && detail === TOKEN_BUDGET_MESSAGE && calls === callsBefore && refusedRow?.outcome === "RATE_LIMITED" && refusedRow.inputTokens === 0, code || "not refused");

  // ── T6 ──
  await spread(noida.actor.userId);
  const lookup = await askAi(noida.actor, { mode: "CHART_QA", patientId: noida.patientId, question: "Latest hemoglobin?" });
  report("T6: at 100% a Tier 0 answer from the structured records is still given", lookup.outcome === "ANSWERED" && lookup.trace?.tier === 0 && calls === callsBefore && lookup.sentences.some((s) => s.text.includes("10.4")), `${lookup.outcome}, tier ${lookup.trace?.tier}`);

  // ── T7 ──
  await spread(noida.actor.userId);
  let kcode = "";
  let kOutcome = "";
  try { kOutcome = (await askKnowledge(noida.actor as Extract<AiActor, { kind: "STAFF" }>, { question: `Soiled wound dressing change ${tag}` })).outcome; } catch (err) { if (err instanceof AskError) kcode = err.code; else throw err; }
  report("T7: at 100% a knowledge question that needs the model is refused too", kcode === "FACILITY_TOKEN_BUDGET" && calls === callsBefore, kcode || `not refused: ${kOutcome}`);

  // ── T8 ──
  const other = await askAi(pune.actor, { mode: "VISIT_BRIEF", patientId: pune.patientId });
  report("T8: another facility's requests are untouched", other.outcome === "ANSWERED" && calls === callsBefore + 1);

  await resetOverride(adminM, { ...scope, key: TOKEN_BUDGET_KEY, reason: "token budget gate done" });
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
