/**
 * RAG Phase 5, step 5.8 — GET /api/ai/sources/:id (src/lib/rag/sourceOpen.ts):
 * a citation opens only for a caller who may read the source now. Synthetic
 * patients, mock providers.
 *
 *   S1  the doctor who asked opens an indexed source and a live fact they
 *       were given: the source's own text, never more
 *   S2  another facility's doctor: 404, the same answer as an id that
 *       doesn't exist
 *   S3  a nurse opens a source while assigned; once the assignment has
 *       ended, 404
 *   S4  a knowledge source opens while its version is in force; withdrawn,
 *       404; a role without its access class, 404
 *   S5  the patient opens their own source; another patient, 404
 *   S6  no response carries a hash, a storage reference or another patient
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { emitFacilityEvent } from "../src/lib/events/facilityEvent";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { decidePersonConsent } from "../src/lib/person/consent";
import { askAi, AskError } from "../src/lib/rag/ask";
import { askKnowledge } from "../src/lib/rag/knowledgeAsk";
import { openSource } from "../src/lib/rag/sourceOpen";
import { setRecordAnswerProviderForTest } from "../src/lib/ai/record";
import { approveKnowledgeVersion, uploadKnowledge, withdrawKnowledgeVersion } from "../src/lib/knowledge/service";
import { ingestKnowledgeVersion } from "../src/lib/knowledge/ingest";
import { staffUser } from "./lib/knowledgeGate";
import type { AiActor } from "../src/lib/rag/access";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const PUNE = "fac-amc-pune";
const NOIDA = "fac-amc-noida";
const tag = Date.now().toString(36);

async function drain() {
  registerAllConsumers();
  for (let i = 0; i < 20; i++) if ((await dispatchPendingDomainEvents({ now: new Date(), batchSize: 500, maxDurationMs: 60_000 })).claimed === 0) break;
}
async function opened(actor: AiActor, id: string): Promise<string> {
  try { const s = await openSource(actor, id); return `OK ${s.text}`; } catch (err) { if (err instanceof AskError) return `${err.status} ${err.code}`; throw err; }
}

async function patient(name: string) {
  const reg = await registerPatientAccount({ facilityId: PUNE, fullName: `${name} ${tag}`, email: `src-${name.toLowerCase()}-${tag}@verify.aarogya`, passwordHash: "x", sex: "F", dob: new Date("1972-04-04") });
  if (reg.status !== "LINKED_NEW") throw new Error("fixture patient");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: reg.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC" } });
  await decidePersonConsent({ userId: reg.userId, purpose: "AI_ASSISTANCE", decision: "GRANTED" }).catch(() => null);
  return { userId: reg.userId, personId, patientId: (await prisma.personPatientLink.findFirstOrThrow({ where: { personId, status: "ACTIVE" } })).patientId };
}

async function main() {
  registerAllConsumers();
  setRecordAnswerProviderForTest(null);
  const p = await patient("Sourcegate");
  const other = await patient("Sourceother");
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: PUNE }, select: { id: true } });
  const du = await prisma.user.create({ data: { email: `src-doc-${tag}@verify.aarogya`, passwordHash: "x", role: "DOCTOR", displayName: "Sources gate doctor" } });
  const ds = await prisma.hospitalStaffProfile.create({ data: { userId: du.id, departmentId: dept.id, displayRole: "Physician" } });
  await prisma.facilityMembership.create({ data: { userId: du.id, facilityId: PUNE } });
  const enc = await prisma.encounter.create({ data: { patientId: p.patientId, facilityId: PUNE, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "sources gate", attendingStaffId: ds.id } });
  const o = await prisma.labOrder.create({ data: { encounterId: enc.id, patientId: p.patientId, testName: "Serum albumin", category: "Biochemistry", orderedByStaffId: ds.id } });
  const lr = await prisma.labResult.create({ data: { labOrderId: o.id, value: "2.9", unit: "g/dL", abnormalFlag: "LOW", status: "VERIFIED", resultedAt: new Date("2026-10-07T08:00:00Z") } });
  await prisma.$transaction((tx) => emitFacilityEvent(tx, { type: "LabResultReleased", aggregateId: lr.id, facilityId: PUNE, payload: { resultId: lr.id, orderId: o.id, patientId: p.patientId } }));
  const med = await prisma.medicationOrder.create({ data: { encounterId: enc.id, patientId: p.patientId, drugName: "Pantoprazole", dose: "40 mg", route: "ORAL", frequency: "OD", orderedByStaffId: ds.id, status: "ACTIVE" } });
  await prisma.medicationAdministration.create({ data: { medicationOrderId: med.id, scheduledAt: new Date(Date.now() + 3_600_000), status: "DUE" } });
  await drain();
  const doctor: AiActor = { kind: "STAFF", userId: du.id, role: "DOCTOR", facilityId: PUNE };

  // ── S1 ──
  const brief = await askAi(doctor, { mode: "VISIT_BRIEF", patientId: p.patientId });
  const rows = await prisma.aiInteractionSource.findMany({ where: { interactionId: brief.meta.interactionId }, orderBy: { rank: "asc" } });
  const labRow = rows.find((r) => r.sourceType === "LAB_RESULT" && r.sourceId === lr.id);
  const medRow = rows.find((r) => r.sourceType === "MEDICATION_ORDER" && r.sourceId === med.id);
  const lab1 = labRow ? await opened(doctor, labRow.id) : "no row";
  const med1 = medRow ? await opened(doctor, medRow.id) : "no row";
  report("S1: the asking doctor opens an indexed source and a live fact: the source's own text", lab1.startsWith("OK") && lab1.includes("2.9 g/dL") && med1.startsWith("OK") && med1.includes("Pantoprazole 40 mg"), `${lab1.slice(0, 60)} | ${med1.slice(0, 60)}`);

  // ── S2 ──
  const nu = await prisma.user.create({ data: { email: `src-noida-${tag}@verify.aarogya`, passwordHash: "x", role: "DOCTOR", displayName: "Noida doctor" } });
  const ndept = await prisma.department.findFirstOrThrow({ where: { facilityId: NOIDA }, select: { id: true } });
  await prisma.hospitalStaffProfile.create({ data: { userId: nu.id, departmentId: ndept.id, displayRole: "Physician" } });
  const noida: AiActor = { kind: "STAFF", userId: nu.id, role: "DOCTOR", facilityId: NOIDA };
  const x = labRow ? await opened(noida, labRow.id) : "";
  const none = await opened(doctor, "c0000000000000000000000000");
  report("S2: another facility's doctor gets 404, the same as an id that doesn't exist", x === "404 NOT_FOUND" && none === "404 NOT_FOUND", `${x}; ${none}`);

  // ── S3 ──
  const nurseU = await prisma.user.create({ data: { email: `src-nurse-${tag}@verify.aarogya`, passwordHash: "x", role: "NURSE", displayName: "Sources gate nurse" } });
  const nurseS = await prisma.hospitalStaffProfile.create({ data: { userId: nurseU.id, departmentId: dept.id, displayRole: "Ward Nurse" } });
  const assignment = await prisma.nursingAssignment.create({ data: { facilityId: PUNE, nurseStaffId: nurseS.id, patientId: p.patientId, assignedByStaffId: ds.id, startAt: new Date(Date.now() - 3_600_000) } });
  const nurse: AiActor = { kind: "STAFF", userId: nurseU.id, role: "NURSE", facilityId: PUNE };
  const during = labRow ? await opened(nurse, labRow.id) : "";
  await prisma.nursingAssignment.update({ where: { id: assignment.id }, data: { endAt: new Date(Date.now() - 60_000) } });
  const after = labRow ? await opened(nurse, labRow.id) : "";
  report("S3: a nurse opens a source while assigned; once the assignment has ended, 404", during.startsWith("OK") && after === "404 NOT_FOUND", `${during.slice(0, 20)}; ${after}`);

  // ── S4 ──
  const admin = await staffUser(`src-kadmin-${tag}@verify.aarogya`, "HOSPITAL_ADMIN", PUNE);
  const sup = await staffUser(`src-ksuper-${tag}@verify.aarogya`, "MEDICAL_SUPERINTENDENT", PUNE);
  const k = await uploadKnowledge(admin, { title: `Sources gate SOP ${tag}`, documentType: "SOP", accessClass: "CLINICAL", scope: "FACILITY", fileName: `src-${tag}.md`, declaredType: "text/markdown", bytes: Buffer.from(`# Catheter care ${tag}\n\nChange the urinary catheter bag every 7 days ${tag}.\n`, "utf8") });
  await ingestKnowledgeVersion(k.versionId);
  await approveKnowledgeVersion(sup, k.versionId);
  const kq = await askKnowledge(doctor as Extract<AiActor, { kind: "STAFF" }>, { question: `Urinary catheter bag change ${tag}` });
  // This gate's own document (other gates' documents may be retrieved beside it in a full run).
  const kRow = await prisma.aiInteractionSource.findFirst({ where: { interactionId: kq.meta.interactionId, sourceType: "KNOWLEDGE_DOCUMENT", sourceId: k.documentId }, orderBy: { rank: "asc" } });
  const kOpen = kRow ? await opened(doctor, kRow.id) : "no row";
  const billingU = await staffUser(`src-billing-${tag}@verify.aarogya`, "BILLING_STAFF", PUNE);
  const kBilling = kRow ? await opened({ kind: "STAFF", userId: billingU.userId, role: "BILLING_STAFF", facilityId: PUNE }, kRow.id) : "";
  await withdrawKnowledgeVersion(admin, k.versionId, "sources gate");
  const kAfter = kRow ? await opened(doctor, kRow.id) : "";
  report("S4: a knowledge source opens while in force; withdrawn, 404; a role without its access class, 404",
    kOpen.startsWith("OK") && kOpen.includes("every 7 days") && kBilling === "404 NOT_FOUND" && kAfter === "404 NOT_FOUND", `knowledge ${kq.outcome}; ${kOpen.slice(0, 40)}; ${kBilling}; ${kAfter}`);

  // ── S5 ──
  const pActor: AiActor = { kind: "PATIENT", userId: p.userId };
  const timeline = await askAi(pActor, { mode: "HEALTH_TIMELINE", patientId: p.patientId });
  const tRow = (await prisma.aiInteractionSource.findMany({ where: { interactionId: timeline.meta.interactionId, cited: true } }))[0];
  const own = tRow ? await opened(pActor, tRow.id) : "no row";
  const notOwn = tRow ? await opened({ kind: "PATIENT", userId: other.userId }, tRow.id) : "";
  report("S5: the patient opens their own source; another patient gets 404", own.startsWith("OK") && notOwn === "404 NOT_FOUND", `${own.slice(0, 30)}; ${notOwn}`);

  // ── S6 ──
  const bodies = [lab1, med1, during, kOpen, own].join("\n");
  report("S6: no opened source carries a hash, a storage reference or another patient", !/[0-9a-f]{64}|storageKey|s3:\/\/|Sourceother/i.test(bodies));

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
