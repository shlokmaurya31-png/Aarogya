/**
 * Flagship 2, step 6 — legacy import, phase 1 (docs/LEGACY_IMPORT_DESIGN.md §11).
 *
 *   1. The dry run writes nothing (every table's row count is unchanged) and
 *      reports what it would do.
 *   2. Bad rows are refused, each with its reason: a missing field, an
 *      unmapped code, a date not in the declared format, an MRN twice with
 *      different details, a visit for an unknown patient, a visit older than
 *      the 3-year window, an unknown department, a bad phone; an identity
 *      number column is dropped and never imported.
 *   3. The confirmed run needs the dry run's hash, creates exactly the
 *      accepted rows with their import events, links no Person, and wakes no
 *      live consumer; running the same file again creates nothing.
 *   4. Exact keys only: a second file naming an imported MRN adds visits to
 *      that patient, never a duplicate patient (even with a different name).
 *   5. Another hospital can't see the import (404), and its own dry run of the
 *      same file doesn't see this hospital's patients.
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { confirmImport, dryRunImport, getImportBatch } from "../src/lib/hospital/legacyImport/service";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { tag } from "./lib/shareFixture";

const PUNE = "fac-amc-pune";
const NOIDA = "fac-amc-noida";
let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

/** Every table's row count: the dry run must leave all of them as they were. */
async function tableCounts(): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<{ table: string; n: bigint }[]>(Prisma.sql`
    SELECT c.relname AS table, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I', c.relname), false, true, '')))[1]::text::bigint AS n
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
    WHERE s.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'`);
  return Object.fromEntries(rows.map((r) => [r.table, Number(r.n)]));
}

async function main() {
  registerAllConsumers();
  const S = `OLDHIMS-${tag}`;
  const deptName = (await prisma.department.findFirstOrThrow({ where: { facilityId: PUNE }, select: { name: true } })).name;
  const profile = {
    sourceSystem: S, dateFormat: "DD/MM/YYYY",
    patients: { columns: { mrn: "MRN", fullName: "Name", sex: "Gender", dob: "DOB", phone: "Mobile" }, sex: { M: "M", F: "F" } },
    encounters: { columns: { mrn: "MRN", visitNumber: "Visit", type: "Type", registeredAt: "Date", closedAt: "Closed", department: "Dept", clinician: "Doctor" }, type: { OP: "OPD", IP: "IPD" }, departments: { GM: deptName } },
  };
  const y = new Date().getUTCFullYear();
  const patientsCsv = [
    "MRN,Name,Gender,DOB,Mobile,Aadhaar No",
    `A1-${tag},"Asha Rao, Mrs",F,12/03/1980,9876543210,123412341234`,
    `A2-${tag},Ravi Kumar,M,01/01/1975,,`,
    `A3-${tag},No Sex Given,,01/01/1975,,`,
    `A4-${tag},Unknown Sex,X,01/01/1975,,`,
    `A5-${tag},Bad Date,F,1975-01-01,,`,
    `A6-${tag},Twice One,F,01/01/1990,,`,
    `A6-${tag},Twice Two,F,01/01/1990,,`,
    `A7-${tag},Bad Phone,M,01/01/1990,12345,`,
    `A1-${tag},"Asha Rao, Mrs",F,12/03/1980,9876543210,123412341234`,
  ].join("\n");
  const encountersCsv = [
    "MRN,Visit,Type,Date,Closed,Dept,Doctor",
    `A1-${tag},V1-${tag},OP,05/02/${y - 1} 10:30,05/02/${y - 1} 11:00,GM,Dr A Sharma`,
    `A1-${tag},V2-${tag},IP,10/06/${y - 1},14/06/${y - 1},GM,`,
    `A2-${tag},V3-${tag},OP,01/03/${y - 1},,,`,
    `A9-${tag},V4-${tag},OP,01/03/${y - 1},,,`,
    `A2-${tag},V5-${tag},XR,01/03/${y - 1},,,`,
    `A2-${tag},V6-${tag},OP,01/03/${y - 5},,,`,
    `A2-${tag},V7-${tag},OP,01/03/${y - 1},,ZZ,`,
    `A2-${tag},V8-${tag},OP,01/03/${y - 1},28/02/${y - 1},,`,
  ].join("\n");
  const body = { profile, patientsCsv, encountersCsv };

  // 1. The dry run writes nothing.
  const before = await tableCounts();
  const dry = await dryRunImport(PUNE, body);
  const after = await tableCounts();
  const changed = Object.keys({ ...before, ...after }).filter((t) => before[t] !== after[t]);
  report("The dry run writes nothing (no table's row count changes)", changed.length === 0, changed.join(", ") || `${Object.keys(after).length} tables`);
  report("The dry run reports what it would create", dry.counts.patients.toCreate === 2 && dry.counts.encounters.toCreate === 3, JSON.stringify(dry.counts));

  // 2. Every bad row refused, with its reason.
  const reason = (key: string) => dry.refused.filter((r) => r.sourceKey === key).map((r) => r.reason);
  const expect: [string, string][] = [
    [`A3-${tag}`, "MISSING_FIELD"], [`A4-${tag}`, "UNMAPPED_VALUE"], [`A5-${tag}`, "BAD_DATE"], [`A6-${tag}`, "DUPLICATE_KEY_CONFLICT"], [`A7-${tag}`, "INVALID_PHONE"],
    [`V4-${tag}`, "UNKNOWN_PATIENT"], [`V5-${tag}`, "UNMAPPED_VALUE"], [`V6-${tag}`, "OLDER_THAN_WINDOW"], [`V7-${tag}`, "UNMAPPED_VALUE"], [`V8-${tag}`, "CLOSED_BEFORE_REGISTERED"],
  ];
  for (const [key, why] of expect) report(`${key} is refused: ${why}`, reason(key).includes(why as never), reason(key).join(",") || "accepted");
  report("Both rows of the conflicting MRN are refused, each with its line", dry.refused.filter((r) => r.sourceKey === `A6-${tag}`).length === 2);
  report("The same row twice with the same details is kept once", dry.refused.every((r) => r.sourceKey !== `A1-${tag}`));
  report("The identity-number column is dropped and reported", dry.droppedColumns.includes("Aadhaar No"));
  const mappedAadhaar = await dryRunImport(PUNE, { ...body, profile: { ...profile, patients: { ...profile.patients, columns: { ...profile.patients.columns, phone: "Aadhaar No" } } } }).then(() => false, () => true);
  report("A mapping that uses an identity-number column is refused", mappedAadhaar);

  // 3. The confirmed run.
  report("The confirmed run needs the dry run's hash", await confirmImport({ userId: "x", facilityId: PUNE }, { ...body, dryRunHash: "not-it" }).then(() => false, () => true));
  const admin = await prisma.user.findFirstOrThrow({ where: { email: "admin@amc-demo.aarogya" }, select: { id: true } });
  const run = await confirmImport({ userId: admin.id, facilityId: PUNE }, { ...body, dryRunHash: dry.dryRunHash });
  report("The confirmed run creates exactly the accepted rows", run.status === "COMMITTED" && run.created?.patients === 2 && run.created?.encounters === 3, JSON.stringify(run.created));
  const keys = await prisma.legacyRecordKey.findMany({ where: { facilityId: PUNE, sourceSystem: S } });
  const patientIds = keys.filter((k) => k.kind === "PATIENT").map((k) => k.targetId);
  const imported = await prisma.patient.findMany({ where: { id: { in: patientIds } }, select: { id: true, fullName: true, phone: true, uhid: true, importBatchId: true } });
  report("Imported patients get new UHIDs and keep their old MRN as an exact key", imported.length === 2 && imported.every((p) => p.uhid.startsWith("UHID-") && p.importBatchId === run.batchId));
  report("A quoted name with a comma is read exactly; the phone normalized", imported.some((p) => p.fullName === "Asha Rao, Mrs" && p.phone === "+919876543210"));
  report("No identity number anywhere in what was imported", !JSON.stringify(await prisma.patient.findMany({ where: { id: { in: patientIds } } })).includes("123412341234"));
  const encs = await prisma.encounter.findMany({ where: { patientId: { in: patientIds } } });
  report("Imported visits are CLOSED, with the old dates (in India time)", encs.length === 3 && encs.every((e) => e.status === "CLOSED") && encs.some((e) => e.registeredAt.toISOString() === `${y - 1}-02-05T05:00:00.000Z`));
  report("The legacy clinician is kept as a text name", keys.some((k) => k.clinicianName === "Dr A Sharma (legacy)"));
  report("Imported patients are never linked to a Person", (await prisma.personPatientLink.count({ where: { patientId: { in: patientIds } } })) === 0 && (await prisma.patient.count({ where: { id: { in: patientIds }, userId: { not: null } } })) === 0);
  const events = await prisma.domainEventOutbox.findMany({ where: { facilityId: PUNE, OR: [{ aggregateId: { in: [...patientIds, ...encs.map((e) => e.id), run.batchId] } }] }, select: { eventType: true } });
  report("Every row emitted its import event, and nothing live", events.filter((e) => e.eventType === "LegacyPatientImported").length === 2 && events.filter((e) => e.eventType === "LegacyEncounterImported").length === 3 && events.some((e) => e.eventType === "LegacyImportBatchCommitted") && !events.some((e) => ["PatientRegistered", "EncounterOpened"].includes(e.eventType)), [...new Set(events.map((e) => e.eventType))].join(","));
  for (let i = 0; i < 20; i++) if ((await dispatchPendingDomainEvents({ batchSize: 500, maxDurationMs: 30_000 })).claimed === 0) break;
  const woke = { tasks: await prisma.task.count({ where: { patientId: { in: patientIds } } }), charges: await prisma.charge.count({ where: { patientId: { in: patientIds } } }), notifications: await prisma.personNotification.count({}) - 0, rag: await prisma.ragDocument.count({ where: { patientId: { in: patientIds } } }) };
  report("No live consumer reacts to an import (no task, charge or index entry)", woke.tasks === 0 && woke.charges === 0 && woke.rag === 0, JSON.stringify(woke));
  const again = await confirmImport({ userId: admin.id, facilityId: PUNE }, { ...body, dryRunHash: dry.dryRunHash });
  report("Running the same file again creates nothing", again.status === "ALREADY_IMPORTED" && (await prisma.legacyRecordKey.count({ where: { facilityId: PUNE, sourceSystem: S } })) === keys.length && (await prisma.patient.count({ where: { importBatchId: run.batchId } })) === 2);

  // 4. Exact keys only.
  const second = { profile, patientsCsv: `MRN,Name,Gender\nA1-${tag},Asha R (renamed),F`, encountersCsv: `MRN,Visit,Type,Date\nA1-${tag},V9-${tag},OP,01/04/${y - 1}` };
  const dry2 = await dryRunImport(PUNE, second);
  report("A second file naming an imported MRN: no new patient, the visit added to that one", dry2.counts.patients.toCreate === 0 && dry2.counts.patients.alreadyImported === 1 && dry2.counts.encounters.toCreate === 1, JSON.stringify(dry2.counts));
  await confirmImport({ userId: admin.id, facilityId: PUNE }, { ...second, dryRunHash: dry2.dryRunHash });
  const asha = keys.find((k) => k.kind === "PATIENT" && k.sourceKey === `A1-${tag}`)!.targetId;
  report("…and the imported patient keeps their name (nothing is updated by a re-import)", (await prisma.patient.findUniqueOrThrow({ where: { id: asha } })).fullName === "Asha Rao, Mrs" && (await prisma.encounter.count({ where: { patientId: asha } })) === 3);

  // 5. Another hospital.
  report("Another hospital can't see the import (404)", await getImportBatch(NOIDA, run.batchId).then(() => false, (e) => (e as Error).constructor.name === "NotFoundError"));
  const noidaDry = await dryRunImport(NOIDA, body);
  report("…and its own dry run of the same file doesn't match this hospital's patients", noidaDry.counts.patients.toCreate === 2 && noidaDry.counts.patients.alreadyImported === 0 && noidaDry.alreadyImported === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
