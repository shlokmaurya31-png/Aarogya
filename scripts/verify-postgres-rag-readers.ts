/**
 * RAG Phase 3, step 3.3 — the structured readers gate
 * (docs/RAG_IMPLEMENTATION_PLAN.md §5.1): every reader under every access
 * path returns only what that path allows. Synthetic data; canaries are
 * planted in the rows each limit excludes, and each absence has a positive
 * control beside it.
 *
 *   TREATING        every reader; the newest released result, never an
 *                   unreleased or superseded one; imported values after the
 *                   verified one, with the disagreement stated
 *   NURSE_ASSIGNED  the same for her patient; another patient is a 404
 *   SHARE (LABS from 2026, nothing sensitive)  labs inside the period only;
 *                   no vitals, problems, imaging or encounter; no imported
 *                   value; no HIV order
 *   SHARE (LABS, VITALS, CONDITIONS, IMAGING, HIV opt-in)  the HIV order,
 *                   vitals, imaging; never the mental-health diagnosis
 *   ORG_CONSENT (LAB)  labs, nothing sensitive, nothing else
 *   OWN, PROXY      no reader runs for a patient's own modes
 * Another patient's canary (same facility, same doctor) never appears in any
 * reader's output for this patient. Through askAi: "latest haemoglobin" is
 * answered by the reader with no vector or keyword search, and cites it.
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { emitFacilityEvent } from "../src/lib/events/facilityEvent";
import { AiAccessError, resolveAiAccess, type AiAccess, type AiActor } from "../src/lib/rag/access";
import { runReaders } from "../src/lib/rag/readers";
import { routeQuestion, type ReaderId, type RetrievalPlan } from "../src/lib/rag/router";
import { retrieve } from "../src/lib/rag/retrieve";
import { askAi } from "../src/lib/rag/ask";
import { issueAccessCode, redeemAccessCode } from "../src/lib/patient/accessSession";
import { parseShareChoice } from "../src/lib/sharing/categories";
import { setRecordAnswerProviderForTest } from "../src/lib/ai/record";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const tag = Date.now().toString(36).replace(/[^a-z0-9]/g, "");
const canary = (k: string) => `canary${k}${tag}`;
const PUNE = "fac-amc-pune", NOIDA = "fac-amc-noida";
let seq = 0;
let clock = Date.now();

async function drain() {
  for (let i = 0; i < 40; i++) {
    clock += 2 * 3_600_000;
    if ((await dispatchPendingDomainEvents({ now: new Date(clock), batchSize: 500, maxDurationMs: 60_000 })).claimed === 0) return;
  }
}

async function staff(facilityId: string, role: "DOCTOR" | "NURSE") {
  seq += 1;
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId }, select: { id: true } });
  const user = await prisma.user.create({ data: { email: `rag-readers-${role.toLowerCase()}-${tag}-${seq}@verify.aarogya`, passwordHash: "x", role, displayName: `Readers ${role}` } });
  const p = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: role === "NURSE" ? "Ward Nurse" : "Physician" } });
  return { staffId: p.id, userId: user.id, actor: { kind: "STAFF", userId: user.id, role, facilityId } as AiActor };
}

async function patient(facilityId = PUNE) {
  seq += 1;
  const a = await registerPatientAccount({ facilityId, fullName: `Readers ${tag} ${seq}`, email: `rag-readers-${tag}-${seq}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1975-05-05") });
  if (a.status !== "LINKED_NEW") throw new Error("fixture patient");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: a.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC" } });
  const patientId = (await prisma.personPatientLink.findFirstOrThrow({ where: { personId, status: "ACTIVE" } })).patientId;
  const enc = await prisma.encounter.create({ data: { patientId, facilityId, type: "IPD", status: "ADMITTED", chiefComplaint: "Readers gate" } });
  return { userId: a.userId, personId, patientId, facilityId, encounterId: enc.id };
}

type P = Awaited<ReturnType<typeof patient>>;
async function lab(p: P, by: string, testName: string, value: string, at: Date, status: "VERIFIED" | "ENTERED" = "VERIFIED", opts: { supersede?: boolean } = {}) {
  const order = await prisma.labOrder.create({ data: { encounterId: p.encounterId, patientId: p.patientId, testName, category: "Biochemistry", orderedByStaffId: by, status: "RESULTED" } });
  const r = await prisma.labResult.create({ data: { labOrderId: order.id, value, unit: "g/dL", referenceRange: "12.0 - 15.5", status, resultedAt: at } });
  if (opts.supersede) {
    await prisma.labResult.update({ where: { id: r.id }, data: { isCurrent: false, status: "SUPERSEDED" } });
  } else if (status === "VERIFIED") {
    await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LabResultReleased", aggregateId: r.id, facilityId: p.facilityId, payload: { resultId: r.id, orderId: order.id, patientId: p.patientId } }));
  }
  return r;
}

const plan = (readers: ReaderId[], entities: Partial<RetrievalPlan["entities"]> = {}): RetrievalPlan => ({
  intent: "STRUCTURED_LOOKUP", readers, semantic: false, keyword: false, risk: "CLINICAL", confidence: "RULE", matched: [], entities: { latest: true, trend: false, ...entities },
});
const text = (facts: { context: string; text: string }[]) => facts.map((f) => `${f.context}\n${f.text}`).join("\n");

async function main() {
  registerAllConsumers();
  setRecordAnswerProviderForTest(null);
  const doctor = await staff(PUNE, "DOCTOR");
  const nurse = await staff(PUNE, "NURSE");
  const shareDoctor = await staff(PUNE, "DOCTOR");
  const noidaDoctor = await staff(NOIDA, "DOCTOR");
  const A = await patient();
  const Q = await patient();

  // ── A's record ──
  await lab(A, doctor.staffId, "Hemoglobin", `9.4 ${canary("hbold")}`, new Date("2020-03-03T08:00:00Z"));
  await lab(A, doctor.staffId, "Hemoglobin", `11.6 ${canary("hbnew")}`, new Date("2026-10-10T08:00:00Z"));
  await lab(A, doctor.staffId, "Hemoglobin", `13.9 ${canary("hbentered")}`, new Date("2026-10-12T08:00:00Z"), "ENTERED");
  await lab(A, doctor.staffId, "Hemoglobin", `7.1 ${canary("hbsup")}`, new Date("2026-10-11T08:00:00Z"), "VERIFIED", { supersede: true });
  await lab(A, doctor.staffId, "HbA1c", `7.9 ${canary("a1c")}`, new Date("2026-10-10T08:00:00Z"));
  const legacy = async (p: P, testName: string, value: string, at: Date, k: string) => {
    const l = await prisma.legacyLabResult.create({ data: { facilityId: p.facilityId, patientId: p.patientId, batchId: `readers-${tag}`, sourceSystem: `OldHIS${canary(k)}`, testCode: "HB", testName, value, unit: "g/dL", referenceRange: "12.0 - 15.5", abnormalFlag: "L", observedAt: at } });
    await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LegacyResultImported", aggregateId: l.id, facilityId: p.facilityId, payload: { resultId: l.id, patientId: p.patientId, batchId: `readers-${tag}`, converted: false } }));
  };
  // Imported after the verified one in time: still never the latest.
  await legacy(A, "Hemoglobin", "10.2", new Date("2026-11-01T08:00:00Z"), "imphb");
  await legacy(A, "Sodium", "133", new Date("2025-06-01T08:00:00Z"), "impna");
  await prisma.vital.create({ data: { encounterId: A.encounterId, recordedByStaffId: nurse.staffId, hr: 101, sbp: 138, dbp: 86, spo2: 94, rr: 18, tempC: 37.9, recordedAt: new Date(Date.now() - 3_600_000) } });
  await prisma.labOrder.create({ data: { encounterId: A.encounterId, patientId: A.patientId, testName: `Potassium ${canary("pend")}`, category: "Biochemistry", orderedByStaffId: doctor.staffId, status: "COLLECTED" } });
  await prisma.labOrder.create({ data: { encounterId: A.encounterId, patientId: A.patientId, testName: `HIV 1/2 antibody ${canary("hivpend")}`, category: "Serology", orderedByStaffId: doctor.staffId } });
  await prisma.imagingOrder.create({ data: { encounterId: A.encounterId, patientId: A.patientId, modality: "XRAY", studyDescription: `Chest PA ${canary("img")}`, orderedByStaffId: doctor.staffId } });
  const bed = await prisma.bed.findFirstOrThrow({ where: { facilityId: PUNE }, select: { id: true, label: true } });
  await prisma.admission.create({ data: { encounterId: A.encounterId, bedId: bed.id, reason: `Pneumonia ${canary("adm")}`, admittingStaffId: doctor.staffId } });
  await prisma.diagnosis.create({ data: { patientId: A.patientId, encounterId: A.encounterId, diagnosis: `Type 2 diabetes ${canary("dx")}`, type: "FINAL", code: "E11.9", codeSystem: "ICD-10", diagnosedByStaffId: doctor.staffId } });
  await prisma.diagnosis.create({ data: { patientId: A.patientId, encounterId: A.encounterId, diagnosis: `Depressive episode ${canary("mh")}`, type: "FINAL", code: "F32.9", codeSystem: "ICD-10", diagnosedByStaffId: doctor.staffId } });
  await prisma.problem.create({ data: { patientId: A.patientId, diagnosis: `Hypertension ${canary("prob")}`, status: "ACTIVE" } });

  // ── Q's record: the same doctor treats Q; nothing of Q may come through A ──
  await lab(Q, doctor.staffId, "Hemoglobin", `12.2 ${canary("qhb")}`, new Date("2026-10-15T08:00:00Z"));
  await legacy(Q, "Hemoglobin", "12.0", new Date("2026-11-02T08:00:00Z"), "qimp");
  await prisma.vital.create({ data: { encounterId: Q.encounterId, recordedByStaffId: nurse.staffId, hr: 177, spo2: 77, recordedAt: new Date() } });
  await prisma.labOrder.create({ data: { encounterId: Q.encounterId, patientId: Q.patientId, testName: `Potassium ${canary("qpend")}`, category: "Biochemistry", orderedByStaffId: doctor.staffId } });
  await prisma.diagnosis.create({ data: { patientId: Q.patientId, encounterId: Q.encounterId, diagnosis: `Asthma ${canary("qdx")}`, type: "FINAL", diagnosedByStaffId: doctor.staffId } });
  await prisma.encounter.update({ where: { id: Q.encounterId }, data: { chiefComplaint: `Fever ${canary("qenc")}` } });
  await prisma.nursingAssignment.create({ data: { facilityId: PUNE, nurseStaffId: nurse.staffId, patientId: A.patientId, assignedByStaffId: doctor.staffId, startAt: new Date(Date.now() - 3_600_000) } });
  await drain();

  const Q_CANARIES = ["qhb", "qimp", "qpend", "qdx", "qenc"].map(canary);
  const all: string[] = [];
  const readAll = async (access: AiAccess) => {
    const out = {
      latest: await runReaders(access, plan(["LAB_LATEST"], { analyte: "Hemoglobin" })),
      trend: await runReaders(access, plan(["LAB_TREND"], { analyte: "Hemoglobin", latest: false, trend: true })),
      sodium: await runReaders(access, plan(["LAB_LATEST"], { analyte: "Sodium" })),
      vitals: await runReaders(access, plan(["VITALS"])),
      orders: await runReaders(access, plan(["ORDERS_PENDING"])),
      encounter: await runReaders(access, plan(["ENCOUNTER_CURRENT"])),
      problems: await runReaders(access, plan(["PROBLEMS"])),
    };
    all.push(...Object.values(out).map(text));
    return out;
  };
  const has = (facts: { context: string; text: string }[], k: string) => text(facts).includes(canary(k));

  // ── TREATING ──
  const treating = await resolveAiAccess(doctor.actor, { mode: "CHART_QA", patientId: A.patientId });
  const t = await readAll(treating);
  report("TREATING: the latest haemoglobin is the newest released result", t.latest[0]?.origin === "VERIFIED" && has(t.latest.slice(0, 1), "hbnew"), t.latest[0]?.text);
  report("TREATING: never an unreleased (ENTERED) or a superseded result", !has(t.latest, "hbentered") && !has(t.latest, "hbsup") && !has(t.trend, "hbentered") && !has(t.trend, "hbsup"));
  report("TREATING: haemoglobin never reads glycated haemoglobin", !has(t.latest, "a1c") && !has(t.trend, "a1c"));
  report("TREATING: the imported value comes after the verified one, labelled, though it is newer", t.latest.findIndex((f) => f.origin === "IMPORTED") > 0 && t.latest.filter((f) => f.origin === "IMPORTED").every((f) => /imported/i.test(f.context)) && has(t.latest, "imphb"));
  const diff = t.latest.find((f) => f.chunkId.startsWith("live:labdiff:"));
  report("TREATING: the disagreement with the verified value is stated", !!diff && /differs from the latest verified value/.test(diff.text) && diff.text.includes("10.2"), diff?.text);
  report("TREATING: the trend has both verified results, newest first, imported after", has(t.trend, "hbold") && has(t.trend, "hbnew") && text(t.trend).indexOf(canary("hbnew")) < text(t.trend).indexOf(canary("hbold")) && t.trend.findIndex((f) => f.origin === "IMPORTED") > t.trend.findLastIndex((f) => f.origin === "VERIFIED"));
  report("TREATING: an analyte with only an imported value gives it, labelled imported", t.sodium.length === 1 && t.sodium[0].origin === "IMPORTED" && has(t.sodium, "impna"));
  const per = await runReaders(treating, plan(["LAB_TREND"], { analyte: "Hemoglobin", period: { from: new Date("2026-01-01T00:00:00Z") }, trend: true }));
  report("TREATING: a question's period applies (2026 on: not the 2020 result)", has(per, "hbnew") && !has(per, "hbold"));
  report("TREATING: the latest vitals", t.vitals.length === 1 && /SpO2 94%/.test(t.vitals[0].text) && /HR 101\/min/.test(t.vitals[0].text));
  report("TREATING: pending lab and imaging orders, the HIV order included (the treating team sees it)", has(t.orders, "pend") && has(t.orders, "img") && has(t.orders, "hivpend"));
  report("TREATING: a resulted order is not pending", !text(t.orders).includes("Hemoglobin"));
  report("TREATING: the current encounter, with the bed", t.encounter.length === 1 && t.encounter[0].text.includes(bed.label) && has(t.encounter, "adm"));
  report("TREATING: diagnoses and the problem list, the mental-health one included", has(t.problems, "dx") && has(t.problems, "prob") && has(t.problems, "mh"));

  // ── NURSE_ASSIGNED ──
  const nurseA = await resolveAiAccess(nurse.actor, { mode: "CHART_QA", patientId: A.patientId });
  const n = await readAll(nurseA);
  report("NURSE: her patient's latest result, vitals, orders, encounter", has(n.latest, "hbnew") && n.vitals.length === 1 && has(n.orders, "pend") && n.encounter.length === 1);
  report("NURSE: another patient is a 404", await resolveAiAccess(nurse.actor, { mode: "CHART_QA", patientId: Q.patientId }).then(() => false, (e) => e instanceof AiAccessError && e.status === 404));

  // ── SHARE: LABS from 2026, nothing sensitive ──
  const code = async (choice: Parameters<typeof parseShareChoice>[0]) => {
    const issued = await issueAccessCode(A.patientId, A.userId, "readers gate", { choice: parseShareChoice(choice) });
    const s = await redeemAccessCode({ code: issued.code, doctorUserId: shareDoctor.userId, doctorStaffId: shareDoctor.staffId, doctorName: "Readers doctor", facilityId: PUNE });
    if (!s) throw new Error("redeem");
    return s.id;
  };
  const s1 = await resolveAiAccess(shareDoctor.actor, { mode: "CHART_QA", patientId: A.patientId, shareId: await code({ categories: ["LABS"], period: { from: "2026-01-01" } }) });
  const sh = await readAll(s1);
  report("SHARE (labs from 2026): the 2026 result (control)", has(sh.latest, "hbnew") && has(sh.trend, "hbnew"));
  report("SHARE (labs from 2026): never the 2020 result", !has(sh.trend, "hbold"));
  report("SHARE: no imported value, and no disagreement line", !sh.latest.some((f) => f.origin === "IMPORTED") && !sh.trend.some((f) => f.origin === "IMPORTED") && sh.sodium.length === 0);
  report("SHARE without VITALS, CONDITIONS or IMAGING: no vitals, no problems, no imaging order", sh.vitals.length === 0 && sh.problems.length === 0 && !has(sh.orders, "img"));
  report("SHARE: the pending lab order (LABS), never the HIV order without its opt-in", has(sh.orders, "pend") && !has(sh.orders, "hivpend"));
  report("SHARE: never the current encounter (the treating team's only)", sh.encounter.length === 0);
  const s2 = await resolveAiAccess(shareDoctor.actor, { mode: "CHART_QA", patientId: A.patientId, shareId: await code({ categories: ["LABS", "VITALS", "CONDITIONS", "IMAGING"], sensitiveCategories: ["HIV"] }) });
  const sh2 = await readAll(s2);
  report("SHARE with VITALS, CONDITIONS, IMAGING and the HIV opt-in: vitals, problems, imaging and the HIV order (controls)", sh2.vitals.length === 1 && has(sh2.problems, "dx") && has(sh2.orders, "img") && has(sh2.orders, "hivpend"));
  report("SHARE: the mental-health diagnosis needs its own opt-in", !has(sh2.problems, "mh"));
  report("SHARE: with no period, the 2020 result (control for the period)", has(sh2.trend, "hbold"));

  // ── ORG_CONSENT: Noida, with the patient's consent to the organisation (LAB) ──
  const org = await prisma.facility.findUniqueOrThrow({ where: { id: PUNE }, select: { organizationId: true } });
  await prisma.interopConsent.create({ data: { facilityId: PUNE, patientId: A.patientId, purpose: "TREATMENT", status: "GRANTED", recipientType: "ORGANIZATION", recipientIdentifier: org.organizationId, grantedAt: new Date(), grantedBy: "PATIENT", scopes: { create: [{ scope: "LAB" }] } } });
  const oc = await readAll(await resolveAiAccess(noidaDoctor.actor, { mode: "CHART_QA", patientId: A.patientId }));
  report("ORG_CONSENT (LAB): the lab results (control)", has(oc.latest, "hbnew"));
  report("ORG_CONSENT: no imported value, no vitals, problems or encounter", !oc.latest.some((f) => f.origin === "IMPORTED") && oc.vitals.length === 0 && oc.problems.length === 0 && oc.encounter.length === 0);
  report("ORG_CONSENT: nothing sensitive (no HIV order)", has(oc.orders, "pend") && !has(oc.orders, "hivpend"));

  // ── OWN: the patient's own modes never reach a reader ──
  const own = await resolveAiAccess({ kind: "PATIENT", userId: A.userId }, { mode: "HEALTH_TIMELINE", patientId: A.patientId });
  const o = await readAll(own);
  report("OWN: no reader returns anything for a patient's own mode", Object.values(o).every((x) => x.length === 0));
  report("OWN: and a patient mode is never routed", (await retrieve(own, {})).plan === null);

  // ── Another patient's canaries, anywhere ──
  report("Another patient's canary never appears in any reader's output for this patient", Q_CANARIES.every((c) => !all.join("\n").includes(c)), Q_CANARIES.filter((c) => all.join("\n").includes(c)).join());
  const qAccess = await resolveAiAccess(doctor.actor, { mode: "CHART_QA", patientId: Q.patientId });
  report("Control: Q's own access finds Q's canaries", text(await runReaders(qAccess, plan(["LAB_LATEST"], { analyte: "Hemoglobin" }))).includes(canary("qhb")));

  // ── Through askAi: a lookup answered by the reader, no search ──
  const r = await askAi(doctor.actor, { mode: "CHART_QA", patientId: A.patientId, question: "What was the latest hemoglobin?" });
  report("askAi: answered by the reader, with no vector or keyword search", r.outcome === "ANSWERED" && r.trace?.answeredByReader === true && r.trace.readers.includes("LAB_LATEST"), JSON.stringify(r.trace));
  report("askAi: the answer cites the reader's fact (a verified lab result)", r.citations.some((c) => c.sourceType === "LAB_RESULT" && c.origin === "VERIFIED" && c.chunkId.startsWith("live:lab:")) && r.sentences.some((s) => s.text.includes(canary("hbnew"))));
  const row = await prisma.aiInteraction.findUniqueOrThrow({ where: { id: r.meta.interactionId }, include: { sources: { orderBy: { rank: "asc" } } } });
  report("askAi: the interaction records the reader's facts as LIVE sources, first", row.sources[0]?.sourceKind === "LIVE" && row.sources[0].sourceType === "LAB_RESULT");
  const viaRetrieve = await retrieve(treating, { question: "What was the latest hemoglobin?" });
  report("retrieve: no candidate search ran (no index chunk was even a candidate)", viaRetrieve.answeredByReader && viaRetrieve.candidateIds.length === 0 && viaRetrieve.chunks.length === 0);
  const narrative = await retrieve(treating, { question: "What did the chest X-ray show?" });
  report("Control: a narrative question still searches the index", !narrative.answeredByReader && narrative.plan?.intent === "NARRATIVE");
  report("Router: 'latest Hb' is a structured lookup in chart Q&A", routeQuestion("latest Hb", "CHART_QA").kind === "PLAN");

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
