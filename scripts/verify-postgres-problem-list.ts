/**
 * D3: Problem and Diagnosis stay separate; "add to problem list" links an
 * encounter diagnosis to a problem (Diagnosis.problemId), and both carry the
 * same code field (codeSystem + code + codeDisplay).
 *
 *   1. The code field exists on both and the database refuses a half code.
 *   2. Adding a coded diagnosis creates a problem with the same code and links it.
 *   3. It is idempotent, and two concurrent adds create one problem.
 *   4. A later diagnosis with the same code links to the existing problem.
 *   5. An uncoded diagnosis links to an uncoded problem with the same text.
 *   6. A provisional diagnosis becomes a suspected problem; one entered in
 *      error is refused; another facility gets 404.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-problem-list.ts
 */
import { prisma } from "../src/lib/db";
import { NotFoundError } from "../src/lib/auth/rbac";
import { addDiagnosisToProblemList } from "../src/lib/hospital/problemList";
import { staffAtFacilityWhere } from "../src/lib/auth/staffFacility";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refused = (p: Promise<unknown>) => p.then(() => false, () => true);

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const doctor = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { AND: [staffAtFacilityWhere(facilityId), { user: { role: "DOCTOR" } }] }, orderBy: { id: "asc" } });
  const patient = await prisma.patient.create({ data: { uhid: `D3-${run}`, facilityId, fullName: `Problem List ${run}`, sex: "M" } });
  const encounter = () => prisma.encounter.create({ data: { facilityId, patientId: patient.id, type: "OPD" } });
  const e1 = await encounter();
  const e2 = await encounter();
  const dx = (encounterId: string, data: Partial<{ diagnosis: string; type: string; status: string; codeSystem: string; code: string; codeDisplay: string }>) =>
    prisma.diagnosis.create({ data: { patientId: patient.id, encounterId, diagnosis: "Type 2 diabetes mellitus", type: "FINAL", diagnosedByStaffId: doctor.id, ...data } });
  const add = (diagnosisId: string, fac = facilityId) => addDiagnosisToProblemList({ facilityId: fac, diagnosisId, byUserId: doctor.userId });

  // 1. Code field and CHECK.
  for (const table of ["Problem", "Diagnosis"]) {
    const cols = (await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = ${table}`).map((c) => c.column_name);
    report(`${table} has codeSystem, code and codeDisplay`, ["codeSystem", "code", "codeDisplay"].every((c) => cols.includes(c)));
  }
  report("The database refuses a problem code without its system",
    await refused(prisma.problem.create({ data: { patientId: patient.id, diagnosis: "x", status: "active", code: "E11" } })));
  report("…and a diagnosis display without a code", await refused(dx(e1.id, { codeDisplay: "Diabetes" })));

  // 2–3. Coded diagnosis → new problem; idempotent; concurrent.
  const icd = { codeSystem: "http://hl7.org/fhir/sid/icd-10", code: "E11.9", codeDisplay: "Type 2 diabetes mellitus without complications" };
  const d1 = await dx(e1.id, icd);
  const r1 = await add(d1.id);
  report("Adding a coded diagnosis creates a problem", r1.created && r1.problem.patientId === patient.id && r1.problem.status === "active");
  report("…with the same code field", r1.problem.codeSystem === icd.codeSystem && r1.problem.code === icd.code && r1.problem.codeDisplay === icd.codeDisplay);
  report("…and links the diagnosis", (await prisma.diagnosis.findUniqueOrThrow({ where: { id: d1.id } })).problemId === r1.problem.id);
  const again = await add(d1.id);
  report("Adding it again returns the same problem without a new one", !again.created && again.problem.id === r1.problem.id);
  const d1b = await dx(e1.id, { diagnosis: "Hypothyroidism", codeSystem: icd.codeSystem, code: "E03.9" });
  const race = await Promise.allSettled([add(d1b.id), add(d1b.id)]);
  const thyroid = await prisma.problem.count({ where: { patientId: patient.id, code: "E03.9" } });
  report("Two concurrent adds create one problem", thyroid === 1 && race.some((r) => r.status === "fulfilled"), `${thyroid} problem(s)`);

  // 4. Same code on a later encounter links to the existing problem.
  const d2 = await dx(e2.id, { ...icd, diagnosis: "T2DM, follow-up" });
  const r2 = await add(d2.id);
  report("A later diagnosis with the same code links to the existing problem", !r2.created && r2.problem.id === r1.problem.id);

  // 5. Uncoded → uncoded problem with the same text.
  const htn = await prisma.problem.create({ data: { patientId: patient.id, diagnosis: "Essential hypertension", status: "active" } });
  const d3 = await dx(e2.id, { diagnosis: "  essential HYPERTENSION " });
  const r3 = await add(d3.id);
  report("An uncoded diagnosis links to the uncoded problem with the same text", !r3.created && r3.problem.id === htn.id);

  // 6. Provisional, entered in error, other facility.
  const d4 = await dx(e2.id, { diagnosis: "Suspected pulmonary TB", type: "PROVISIONAL" });
  report("A provisional diagnosis becomes a suspected problem", (await add(d4.id)).problem.status === "suspected");
  const d5 = await dx(e2.id, { diagnosis: "Wrong patient", status: "ENTERED_IN_ERROR" });
  report("A diagnosis entered in error is refused", await refused(add(d5.id)));
  const d6 = await dx(e2.id, { diagnosis: "Asthma" });
  const cross = await add(d6.id, "fac-amc-noida").then(() => "added", (e) => (e instanceof NotFoundError ? "404" : String(e)));
  report("Another facility gets 404", cross === "404");
  report("Problem and Diagnosis stay separate records",
    (await prisma.diagnosis.count({ where: { patientId: patient.id } })) > (await prisma.problem.count({ where: { patientId: patient.id } })));

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
