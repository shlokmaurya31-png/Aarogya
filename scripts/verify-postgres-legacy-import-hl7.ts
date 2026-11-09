/**
 * Flagship 5 — legacy import phase 2: HL7 v2 ADT and ORU, synthetic messages
 * only (docs/LEGACY_IMPORT_DESIGN.md §11.2).
 *
 *   1. The dry run reads every message and writes nothing: patients, visits
 *      and results to create; each refusal with its message and reason (an
 *      open admission at cut-over, an unsupported message, an unmapped test or
 *      unit, a result not final or not a number, an unknown patient, older
 *      than the window); identity numbers (PID-19, a national id in PID-3)
 *      dropped and named. A mapping that takes an identity type as the MRN,
 *      or a file that isn't HL7, is refused whole.
 *   2. The confirmed run, in chunks: new UHIDs; visits CLOSED with their
 *      discharge time; results kept apart from the live results (no
 *      LabResult), a unit converted only on its exact mapping (the sent value
 *      kept beside it); each row with its (bulk-lane) event; no identity
 *      number anywhere; "Recorded by: <name> (imported)".
 *   3. The chart's trend labels imported points "imported".
 *   4. The same file again is a no-op; an update with other details goes to
 *      the review queue, never applied.
 *   5. Another hospital can't see the batch (404).
 *
 * Runs in a facility of its own. Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";
import { confirmImport, dryRunImport, getImportBatch } from "../src/lib/hospital/legacyImport/service";
import { importedRecordedBy } from "../src/lib/hospital/legacyImport/display";
import { labTrend } from "../src/lib/hospital/labTrend";
import { tag } from "./lib/shareFixture";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refusedWith = <T>(p: Promise<T>, name: string) => p.then(() => false, (e) => (e as Error).constructor.name === name);
/** A segment from its fields by number (HL7 numbering): a synthetic fixture can't miscount pipes. */
const seg = (name: string, f: Record<number, string>) => [name, ...Array.from({ length: Math.max(...Object.keys(f).map(Number)) }, (_, i) => f[i + 1] ?? "")].join("|");
const msh = (type: string, id: string, at: string) => `MSH|^~\\&|OLDHIMS|PUNE|AAROGYA|PUNE|${at}||${type}|${id}|P|2.5`;

async function main() {
  const pune = await prisma.facility.findUniqueOrThrow({ where: { id: "fac-amc-pune" }, select: { organizationId: true } });
  const fac = await prisma.facility.create({ data: { name: `HL7 import ${tag}`, organizationId: pune.organizationId } });
  await prisma.department.create({ data: { facilityId: fac.id, name: "General Medicine" } });
  const user = await prisma.user.create({ data: { email: `hl7-${tag}@verify.aarogya`, passwordHash: "x", role: "HOSPITAL_ADMIN", displayName: "HL7 admin" } });
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: fac.id } });
  await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: "HOSPITAL_ADMIN" } });
  await ensurePrimaryMembership(prisma, user.id, fac.id, { isAdmin: true });
  const admin = { userId: user.id, facilityId: fac.id };
  const S = `HL7HIMS-${tag}`;
  const y = new Date().getUTCFullYear() - 1;
  const old = new Date().getUTCFullYear() - 4;
  const profile = {
    sourceSystem: S, format: "HL7V2", mrnIdentifierType: "MR",
    sex: { M: "M", F: "F" }, patientClass: { I: "IPD", O: "OPD", E: "ED" }, departments: { GM: "General Medicine" },
    results: { tests: {
      HGB: { name: "Haemoglobin", unit: "g/dL" },
      GLU: { name: "Glucose", unit: "mg/dL", convert: { "mmol/L": 18.0 } },
      CREAT: { name: "Creatinine", unit: "umol/L" },
      CRP: { name: "CRP", unit: "mg/L" },
    } },
  };
  const SSN = "999-11-2222";
  const NATIONAL = "123412341234";
  const pid = (mrn: string, family: string, given: string, dob: string, sex: string, phone = "") => seg("PID", { 1: "1", 3: `${mrn}^^^PUNE^MR~${NATIONAL}^^^UIDAI^NI`, 5: `${family}^${given}`, 7: dob, 8: sex, 13: phone, 19: SSN });
  const pv1 = (cls: string, visit: string, admit: string, discharge = "") => seg("PV1", { 1: "1", 2: cls, 7: "123^Sharma^Anita^^^Dr", 10: "GM", 19: visit, 44: admit, 45: discharge });
  const obx = (n: number, type: string, code: string, value: string, unit: string, status = "F", at = `${y}0402090000`) => seg("OBX", { 1: String(n), 2: type, 3: `${code}^${code}^LOCAL`, 5: value, 6: unit, 7: "", 8: "", 11: status, 14: at });
  const M = (mrn: string) => `${mrn}-${tag}`;
  const hl7 = [
    msh("ADT^A04", "A1", `${y}0315103000`), pid(M("H1"), "Rao", "Asha", "19800312", "F", "9876543210"), pv1("O", `V1-${tag}`, `${y}03151030`),
    msh("ADT^A01", "A2", `${y}0401080000`), pid(M("H2"), "Kumar", "Ravi", "19750101", "M"), pv1("I", `V2-${tag}`, `${y}04010800`),
    msh("ADT^A03", "A3", `${y}0405120000`), pid(M("H2"), "Kumar", "Ravi", "19750101", "M"), pv1("I", `V2-${tag}`, `${y}04010800`, `${y}04051200`),
    msh("ADT^A01", "A4", `${y}0601080000`), pid(M("H3"), "Iyer", "Meena", "19900101", "F"), pv1("I", `V3-${tag}`, `${y}06010800`),
    msh("ADT^A11", "A5", `${y}0601090000`), pid(M("H3"), "Iyer", "Meena", "19900101", "F"),
    msh("ADT^A08", "A6", `${y}0316103000`), pid(M("H1"), "Rao", "Asha", "19800312", "F", "9876543210"),
    msh("ORU^R01", "R1", `${y}0402090000`), pid(M("H2"), "Kumar", "Ravi", "19750101", "M"), seg("PV1", { 1: "1", 19: `V2-${tag}` }), seg("OBR", { 1: "1", 3: `LAB-${tag}-1`, 4: "CBC", 7: `${y}0402090000` }),
    obx(1, "NM", "HGB", "13.5", "g/dL"), obx(2, "NM", "GLU", "5.5", "mmol/L"), obx(3, "NM", "CREAT", "1.1", "mg/dL"), obx(4, "NM", "ALT", "40", "U/L"), obx(5, "NM", "HGB", "13.1", "g/dL", "P"), obx(6, "NM", "CRP", "high", "mg/L"),
    msh("ORU^R01", "R2", `${y}0402090000`), pid(M("H9"), "Nobody", "Here", "19700101", "M"), seg("OBR", { 1: "1", 3: `LAB-${tag}-2` }), obx(1, "NM", "HGB", "12.0", "g/dL"),
    msh("ORU^R01", "R3", `${old}0101090000`), pid(M("H2"), "Kumar", "Ravi", "19750101", "M"), seg("OBR", { 1: "1", 3: `LAB-${tag}-3` }), obx(1, "NM", "HGB", "11.0", "g/dL", "F", `${old}0101090000`),
  ].join("\r");
  const body = { profile, hl7 };

  // 1. The dry run.
  report("A file that isn't HL7 is refused whole", await refusedWith(dryRunImport(fac.id, { profile, hl7: "PID|1||X" }), "BadRequestError"));
  report("A mapping that takes an identity type as the MRN is refused whole", await refusedWith(dryRunImport(fac.id, { profile: { ...profile, mrnIdentifierType: "NI" }, hl7 }), "BadRequestError"));
  const counts0 = { patients: await prisma.patient.count({ where: { facilityId: fac.id } }), batches: await prisma.legacyImportBatch.count({ where: { facilityId: fac.id } }), results: await prisma.legacyLabResult.count({ where: { facilityId: fac.id } }) };
  const dry = await dryRunImport(fac.id, body);
  const c = dry.counts as unknown as { patients: { toCreate: number }; encounters: { toCreate: number }; results: { toCreate: number; converted: number } };
  report("The dry run reports what it would create", c.patients.toCreate === 3 && c.encounters.toCreate === 2 && c.results.toCreate === 2 && c.results.converted === 1, JSON.stringify(dry.counts));
  for (const r of ["OPEN_ADMISSION", "UNSUPPORTED_MESSAGE", "UNIT_UNMAPPED", "UNMAPPED_TEST", "NOT_FINAL", "NOT_NUMERIC", "UNKNOWN_PATIENT", "OLDER_THAN_WINDOW"]) {
    report(`…refuses with its reason and message: ${r}`, dry.refused.some((x) => x.reason === r && x.line > 0));
  }
  report("…drops identity numbers and says so", dry.droppedColumns.some((d) => d.startsWith("PID-19")) && dry.droppedColumns.some((d) => d.includes("NI")), dry.droppedColumns.join(", "));
  report("…and writes nothing", JSON.stringify(counts0) === JSON.stringify({ patients: await prisma.patient.count({ where: { facilityId: fac.id } }), batches: await prisma.legacyImportBatch.count({ where: { facilityId: fac.id } }), results: await prisma.legacyLabResult.count({ where: { facilityId: fac.id } }) }));

  // 2. The confirmed run, in chunks of two rows.
  const run = await confirmImport(admin, { ...body, dryRunHash: dry.dryRunHash }, { chunkRows: 2 });
  report("The confirmed run commits", run.status === "COMMITTED", run.status);
  const keys = await prisma.legacyRecordKey.findMany({ where: { facilityId: fac.id, sourceSystem: S } });
  const pidOf = (mrn: string) => keys.find((k) => k.kind === "PATIENT" && k.sourceKey === M(mrn))!.targetId;
  const patients = await prisma.patient.findMany({ where: { facilityId: fac.id } });
  report("Patients get new UHIDs (three, the one still admitted too)", patients.length === 3 && patients.every((p) => p.uhid.startsWith("UHID-") && p.importBatchId === run.batchId));
  const v2 = await prisma.encounter.findUniqueOrThrow({ where: { id: keys.find((k) => k.kind === "ENCOUNTER" && k.sourceKey === `V2-${tag}`)!.targetId } });
  report("Visits are CLOSED with their discharge time (India time when the message has no offset)", v2.status === "CLOSED" && v2.closedAt?.toISOString() === new Date(Date.UTC(y, 3, 5, 12, 0) - 330 * 60_000).toISOString() && (await prisma.encounter.count({ where: { facilityId: fac.id } })) === 2);
  const results = await prisma.legacyLabResult.findMany({ where: { facilityId: fac.id }, orderBy: { testName: "asc" } });
  const glu = results.find((r) => r.testCode === "GLU");
  report("Results are kept apart from the live results", results.length === 2 && (await prisma.labResult.count({ where: { labOrder: { patientId: { in: patients.map((p) => p.id) } } } })) === 0);
  report("…a unit converted only on its exact mapping, the sent value kept beside it", glu?.numericValue === 99 && glu.unit === "mg/dL" && glu.originalValue === "5.5" && glu.originalUnit === "mmol/L", JSON.stringify(glu && { v: glu.numericValue, u: glu.unit }));
  report("…and linked to the imported visit", results.every((r) => r.encounterId === v2.id));
  const ev = await prisma.domainEventOutbox.findMany({ where: { facilityId: fac.id, eventType: { in: ["LegacyPatientImported", "LegacyEncounterImported", "LegacyResultImported"] } }, select: { eventType: true, bulk: true } });
  report("Each row has its event, in the bulk lane", ev.filter((e) => e.eventType === "LegacyResultImported").length === 2 && ev.filter((e) => e.eventType === "LegacyPatientImported").length === 3 && ev.every((e) => e.bulk));
  report("…committed in chunks", (await prisma.domainEventOutbox.count({ where: { aggregateId: run.batchId, eventType: "LegacyImportChunkCommitted" } })) >= 4);
  const stored = JSON.stringify([patients, results, keys]);
  report("No identity number anywhere in what was imported", !stored.includes(NATIONAL) && !stored.includes(SSN));
  const v1 = keys.find((k) => k.kind === "ENCOUNTER" && k.sourceKey === `V1-${tag}`)!;
  report("The attending doctor is shown as \"Recorded by: Dr Anita Sharma (imported)\"", (await importedRecordedBy([v1.targetId])).get(v1.targetId) === "Recorded by: Dr Anita Sharma (imported)");

  // 3. The trend.
  const trend = await labTrend(pidOf("H2"), "Haemoglobin");
  report("The chart's trend labels imported points \"imported\"", trend.points.length === 1 && trend.points[0].source === "IMPORTED" && trend.points[0].label === "imported" && trend.points[0].value === 13.5);
  const gTrend = await labTrend(pidOf("H2"), "Glucose");
  report("…with the sent value beside a converted one", gTrend.points[0]?.sent?.unit === "mmol/L" && gTrend.points[0]?.value === 99);

  // 4. Again, and an update.
  report("The same file again is a no-op", (await confirmImport(admin, body)).status === "ALREADY_IMPORTED" && (await prisma.patient.count({ where: { facilityId: fac.id } })) === 3);
  const update = { profile, hl7: [msh("ADT^A08", "U1", `${y}0701100000`), pid(M("H1"), "Rao-Menon", "Asha", "19800312", "F", "9876543210")].join("\r") };
  const uDry = await dryRunImport(fac.id, update);
  await confirmImport(admin, { ...update, dryRunHash: uDry.dryRunHash });
  report("An update with other details goes to the review queue, never applied", (uDry.counts as unknown as { patients: { toReview: number } }).patients.toReview === 1
    && (await prisma.patient.findUniqueOrThrow({ where: { id: pidOf("H1") } })).fullName === "Asha Rao"
    && (await prisma.legacyPatientReview.count({ where: { facilityId: fac.id, patientId: pidOf("H1"), status: "OPEN" } })) === 1);

  // 5. Another hospital.
  report("Another hospital can't see the batch (404)", await refusedWith(getImportBatch("fac-amc-noida", run.batchId), "NotFoundError"));

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
