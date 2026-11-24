/**
 * RAG Phase 5, step 5.6 — OPS_QA and the operational readers
 * (src/lib/rag/opsAsk.ts; docs/RAG_IMPLEMENTATION_PLAN.md §7.1). Synthetic
 * patients with invented names (canaries) at two facilities.
 *
 *   O1  each reader needs its screen's permission: no command centre, no
 *       beds (403); no stock view, no stock (403); never a part answer
 *   O2  an answer names a patient only with that permission: the queue's
 *       names for queue:manage, the critical results' names for
 *       clinical:chart:read; counts for everyone else; never a result value
 *   O3  every answer states when it was read
 *   O4  another facility's state is never returned: its patients' names
 *       never appear, and the counts are this facility's own
 *   O5  logged as every AI request: OPS_QA, tier 0, no model, no text; a
 *       question no reader serves is "no record"
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { registerPatientAccount } from "../src/lib/patient/selfRegistration";
import { AskError } from "../src/lib/rag/ask";
import { askOps } from "../src/lib/rag/opsAsk";
import { staffUser } from "./lib/knowledgeGate";
import type { Role } from "@prisma/client";

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
const READ_AT = /^As of \d{2}:\d{2} IST on \d{4}-\d{2}-\d{2}/;

async function patient(facilityId: string, name: string) {
  const reg = await registerPatientAccount({ facilityId, fullName: name, email: `ops-${name.replace(/\W/g, "").toLowerCase()}-${tag}@verify.aarogya`, passwordHash: "x", sex: "M", dob: new Date("1980-01-01") });
  if (reg.status !== "LINKED_NEW") throw new Error("fixture patient");
  const personId = (await prisma.personAccount.findUniqueOrThrow({ where: { userId: reg.userId } })).personId;
  await prisma.person.update({ where: { id: personId }, data: { dataClassification: "SYNTHETIC" } });
  return (await prisma.personPatientLink.findFirstOrThrow({ where: { personId, status: "ACTIVE" } })).patientId;
}

async function staffAt(facilityId: string, role: Role) {
  const u = await staffUser(`ops-${role.toLowerCase()}-${facilityId}-${tag}@verify.aarogya`, role, facilityId);
  return { kind: "STAFF" as const, userId: u.userId, role, facilityId };
}

async function fixture(facilityId: string, label: string) {
  const queued = await patient(facilityId, `Opsqueue ${label} ${tag}`);
  await prisma.queueEntry.create({ data: { facilityId, queueType: "OPD_DOCTOR", patientId: queued, priorityScore: 50, status: "WAITING", enteredAt: new Date(Date.now() - 25 * 60_000) } });
  const critical = await patient(facilityId, `Opscritical ${label} ${tag}`);
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId }, select: { id: true } });
  const u = await prisma.user.create({ data: { email: `ops-orderer-${facilityId}-${tag}@verify.aarogya`, passwordHash: "x", role: "DOCTOR", displayName: "Ops gate orderer" } });
  const staff = await prisma.hospitalStaffProfile.create({ data: { userId: u.id, departmentId: dept.id, displayRole: "Physician" } });
  const enc = await prisma.encounter.create({ data: { patientId: critical, facilityId, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: "ops gate" } });
  const order = await prisma.labOrder.create({ data: { encounterId: enc.id, patientId: critical, testName: "Serum potassium", category: "Biochemistry", orderedByStaffId: staff.id } });
  await prisma.labResult.create({ data: { labOrderId: order.id, value: "7.9", unit: "mEq/L", abnormalFlag: "HIGH", isCritical: true, status: "VERIFIED", resultedAt: new Date(Date.now() - 40 * 60_000) } });
  const item = await prisma.item.create({ data: { facilityId, sku: `OPS-${label}-${tag}`, name: `Opsgauze ${label} ${tag}`, category: "CONSUMABLE", baseUnit: "PIECE" } });
  const loc = await prisma.stockLocation.create({ data: { facilityId, name: `Ops store ${label} ${tag}`, type: "STORE" } });
  const lot = await prisma.itemLot.create({ data: { itemId: item.id, facilityId, lotNumber: `L-${tag}` } });
  await prisma.stockBalance.create({ data: { facilityId, itemId: item.id, lotId: lot.id, locationId: loc.id, onHandQty: label === "Pune" ? 40 : 900, reservedQty: label === "Pune" ? 5 : 0 } });
}

async function code(p: Promise<unknown>): Promise<string> {
  try { await p; return "OK"; } catch (err) { if (err instanceof AskError) return `${err.status} ${err.code}`; throw err; }
}

async function main() {
  await fixture(PUNE, "Pune");
  await fixture(NOIDA, "Noida");
  const doctor = await staffAt(PUNE, "DOCTOR");
  const frontDesk = await staffAt(PUNE, "FRONT_DESK");
  const billing = await staffAt(PUNE, "BILLING_STAFF");
  const pharmacist = await staffAt(PUNE, "PHARMACIST");
  const superintendent = await staffAt(PUNE, "MEDICAL_SUPERINTENDENT");
  const all: { text: string }[] = [];
  const ask = async (a: Awaited<ReturnType<typeof staffAt>>, question: string) => { const r = await askOps(a, { question }); all.push(...r.sentences); return r; };

  // ── O1 ──
  const supBeds = await code(askOps(superintendent, { question: "How many beds are free?" }));
  const docStock = await code(askOps(doctor, { question: `Stock of Opsgauze Pune ${tag}?` }));
  const docMixed = await code(askOps(doctor, { question: `Beds free and stock of Opsgauze Pune ${tag}?` }));
  const pharmStock = await ask(pharmacist, `How much Opsgauze Pune ${tag} is in stock?`);
  report("O1: each reader needs its screen's permission (beds without the command centre: 403; stock without the stock view: 403, even beside a reader allowed)",
    supBeds === "403 FORBIDDEN" && docStock === "403 FORBIDDEN" && docMixed === "403 FORBIDDEN" && pharmStock.outcome === "ANSWERED" && pharmStock.sentences.some((s) => s.text.includes("35 piece usable (40 on hand, 5 reserved)")),
    `${supBeds}; ${docStock}; ${docMixed}; ${pharmStock.sentences.map((s) => s.text).join(" ")}`);

  // ── O2 ──
  const qBilling = await ask(billing, "Who is waiting in the queue?");
  const qFront = await ask(frontDesk, "Who is waiting in the queue?");
  const cFront = await ask(frontDesk, "Whose critical results are not acknowledged?");
  const cDoctor = await ask(doctor, "Whose critical results are not acknowledged?");
  const text = (r: { sentences: { text: string }[] }) => r.sentences.map((s) => s.text).join(" ");
  report("O2: names only with the screen's permission (the queue: queue:manage; critical results: clinical:chart:read); counts for the rest; never a result value",
    !text(qBilling).includes(`Opsqueue Pune ${tag}`) && /waiting/.test(text(qBilling)) && text(qFront).includes(`Opsqueue Pune ${tag}`)
      && !text(cFront).includes(`Opscritical Pune ${tag}`) && /not yet acknowledged/.test(text(cFront)) && text(cDoctor).includes(`Opscritical Pune ${tag}`) && !text(cDoctor).includes("7.9"),
    `billing: ${text(qBilling).slice(0, 80)}…`);

  // ── O3 ──
  const beds = await ask(doctor, "How many beds are free right now?");
  report("O3: every answer states when it was read", all.length > 0 && all.every((s) => READ_AT.test(s.text)), `${all.length} sentences`);

  // ── O4 ──
  const direct = await prisma.bed.count({ where: { facilityId: PUNE, status: "AVAILABLE" } });
  const total = await prisma.bed.count({ where: { facilityId: PUNE } });
  report("O4: another facility's state is never returned (its names never appear; the counts are this facility's)",
    !all.some((s) => s.text.includes(`Noida ${tag}`)) && beds.sentences.some((s) => s.text.includes(`${direct} of ${total} beds available`)) && !text(pharmStock).includes("900"),
    `${direct} of ${total} at Pune`);

  // ── O5 ──
  const none = await ask(doctor, "What is the weather like?");
  const rows = await prisma.aiInteraction.findMany({ where: { userId: { in: [doctor.userId, frontDesk.userId, billing.userId, pharmacist.userId] }, mode: "OPS_QA" } });
  report("O5: logged as OPS_QA, tier 0, no model, no text; a question no reader serves is no record",
    none.outcome === "NO_RECORD" && rows.length >= 7 && rows.every((r) => r.tier === 0 && r.model === "none" && r.inputTokens === 0 && r.questionCiphertext === null && r.answerCiphertext === null && r.facilityId === PUNE),
    `${rows.length} rows`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
