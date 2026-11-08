/**
 * Flagship 3d — legacy import at scale, resumable, with the review queue
 * (docs/LEGACY_IMPORT_DESIGN.md §10.9–10.11, §11.1).
 *
 *   1. A 50,000-row synthetic patients file (and 2,000 visits): the dry run
 *      writes nothing.
 *   2. A forced failure mid-run (inside chunk 37's transaction): that chunk
 *      rolls back alone, the 37 before it stay (exactly 18,500 patients, each
 *      with its key and event), the batch is FAILED with its event.
 *   3. The same file again resumes after them: exactly 50,000 patients and
 *      2,000 visits, no MRN twice, one import event per row, the chunk events
 *      in order; then the file again is a no-op.
 *   4. A re-import whose details differ is queued for the hospital admin, never
 *      applied; the same difference twice is queued once; an identical row is
 *      a no-op.
 *   5. The admin keeps or accepts, each with a reason, audited, with its event;
 *      accepting changes only the differing fields, and is refused if the
 *      patient changed since; another hospital's admin gets a 404.
 *   6. Imported visits say "Recorded by: <name> (imported)" on the timeline.
 *
 * Runs in a facility of its own (the 50,000 patients stay out of other gates).
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";
import { confirmImport, dryRunImport, IMPORT_CHUNK_ROWS } from "../src/lib/hospital/legacyImport/service";
import { decidePatientReview, listPatientReviews } from "../src/lib/hospital/legacyImport/review";
import { timelinePage } from "../src/lib/patient/timeline";
import { tag } from "./lib/shareFixture";

const ROWS = 50_000;
const VISITS = 2_000;
const FAIL_AT = 37;
let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refusedWith = <T>(p: Promise<T>, name: string) => p.then(() => false, (e) => (e as Error).constructor.name === name);

async function main() {
  const t0 = Date.now();
  const pune = await prisma.facility.findUniqueOrThrow({ where: { id: "fac-amc-pune" }, select: { organizationId: true } });
  const fac = await prisma.facility.create({ data: { name: `Import scale ${tag}`, organizationId: pune.organizationId } });
  const dept = await prisma.department.create({ data: { facilityId: fac.id, name: "General Medicine" } });
  const user = await prisma.user.create({ data: { email: `import-scale-${tag}@verify.aarogya`, passwordHash: "x", role: "HOSPITAL_ADMIN", displayName: "Import admin" } });
  await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: "HOSPITAL_ADMIN" } });
  await ensurePrimaryMembership(prisma, user.id, fac.id, { isAdmin: true });
  const admin = { userId: user.id, facilityId: fac.id };
  const S = `BIGHIMS-${tag}`;
  const profile = {
    sourceSystem: S, dateFormat: "DD/MM/YYYY",
    patients: { columns: { mrn: "MRN", fullName: "Name", sex: "Gender", dob: "DOB", phone: "Mobile" }, sex: { M: "M", F: "F" } },
    encounters: { columns: { mrn: "MRN", visitNumber: "Visit", type: "Type", registeredAt: "Date", department: "Dept", clinician: "Doctor" }, type: { OP: "OPD" }, departments: { GM: "General Medicine" } },
  };
  const y = new Date().getUTCFullYear();
  const mrn = (i: number) => `M${String(i).padStart(6, "0")}`;
  const patientsCsv = ["MRN,Name,Gender,DOB,Mobile", ...Array.from({ length: ROWS }, (_, i) => `${mrn(i)},Synthetic Person ${i},${i % 2 ? "M" : "F"},${String(1 + (i % 28)).padStart(2, "0")}/${String(1 + (i % 12)).padStart(2, "0")}/${1940 + (i % 60)},9${String(800000000 + i).padStart(9, "0")}`)].join("\n");
  const encountersCsv = ["MRN,Visit,Type,Date,Dept,Doctor", ...Array.from({ length: VISITS }, (_, i) => `${mrn(i * 7)},V${i},OP,15/0${1 + (i % 9)}/${y - 1},GM,Dr Legacy ${i % 40}`)].join("\n");
  const body = { profile, patientsCsv, encountersCsv };

  // 1. The dry run.
  const dry = await dryRunImport(fac.id, body);
  report(`A ${ROWS.toLocaleString("en-IN")}-row file: the dry run reports it all`, dry.counts.patients.toCreate === ROWS && dry.counts.encounters.toCreate === VISITS && dry.refused.length === 0, `${JSON.stringify(dry.counts)} in ${Math.round((Date.now() - t0) / 1000)} s`);
  report("…and writes nothing", (await prisma.patient.count({ where: { facilityId: fac.id } })) === 0 && (await prisma.legacyImportBatch.count({ where: { facilityId: fac.id } })) === 0);

  // 2. A forced failure inside chunk 37.
  const t1 = Date.now();
  const failed = await confirmImport(admin, { ...body, dryRunHash: dry.dryRunHash }, { beforeChunkCommit: (c) => { if (c === FAIL_AT) throw new Error("forced failure (gate)"); } }).then(() => null, (e: Error) => e);
  const batch = await prisma.legacyImportBatch.findFirstOrThrow({ where: { facilityId: fac.id } });
  const mid = { patients: await prisma.patient.count({ where: { facilityId: fac.id } }), keys: await prisma.legacyRecordKey.count({ where: { batchId: batch.id } }), events: await prisma.domainEventOutbox.count({ where: { facilityId: fac.id, eventType: "LegacyPatientImported" } }) };
  report("A failure mid-run stops the run", failed?.message === "forced failure (gate)", failed?.message);
  report(`…the failed chunk rolls back alone; the ${FAIL_AT} before it stay, each row with its key and event`, mid.patients === FAIL_AT * IMPORT_CHUNK_ROWS && mid.keys === mid.patients && mid.events === mid.patients, `${JSON.stringify(mid)} in ${Math.round((Date.now() - t1) / 1000)} s`);
  report("…and the batch is FAILED, with its event", batch.status === "FAILED" && batch.chunksCommitted === FAIL_AT && Boolean(batch.lastError) && (await prisma.domainEventOutbox.count({ where: { aggregateId: batch.id, eventType: "LegacyImportBatchFailed" } })) === 1);

  // 3. The same file again: resumes.
  const t2 = Date.now();
  const resumed = await confirmImport(admin, body);
  const keys = await prisma.legacyRecordKey.groupBy({ by: ["kind"], where: { batchId: batch.id }, _count: { _all: true } });
  const dupes = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT "sourceKey" FROM "LegacyRecordKey" WHERE "batchId" = ${batch.id} GROUP BY "kind", "sourceKey" HAVING count(*) > 1) d`;
  report("The same file resumes after the committed chunks and finishes", resumed.status === "COMMITTED" && resumed.created.patients === ROWS && resumed.created.encounters === VISITS, `${JSON.stringify(resumed.created)} in ${Math.round((Date.now() - t2) / 1000)} s`);
  report(`…exactly ${ROWS.toLocaleString("en-IN")} patients and ${VISITS.toLocaleString("en-IN")} visits, no source key twice`,
    (await prisma.patient.count({ where: { facilityId: fac.id } })) === ROWS && (await prisma.encounter.count({ where: { facilityId: fac.id } })) === VISITS && keys.find((k) => k.kind === "PATIENT")?._count._all === ROWS && Number(dupes[0].n) === 0);
  report("…one import event per row", (await prisma.domainEventOutbox.count({ where: { facilityId: fac.id, eventType: "LegacyPatientImported" } })) === ROWS && (await prisma.domainEventOutbox.count({ where: { facilityId: fac.id, eventType: "LegacyEncounterImported" } })) === VISITS);
  const chunkEvents = await prisma.domainEventOutbox.findMany({ where: { aggregateId: batch.id, eventType: "LegacyImportChunkCommitted" }, select: { payload: true }, orderBy: { occurredAt: "asc" } });
  const expectedChunks = Math.ceil(ROWS / IMPORT_CHUNK_ROWS) + Math.ceil(VISITS / IMPORT_CHUNK_ROWS);
  report("…each chunk committed exactly once (numbered on from the failure), and the resume has its event",
    JSON.stringify(chunkEvents.map((e) => (e.payload as { chunk: number }).chunk).sort((a, b) => a - b)) === JSON.stringify(Array.from({ length: expectedChunks }, (_, i) => i)) && (await prisma.domainEventOutbox.count({ where: { aggregateId: batch.id, eventType: "LegacyImportBatchResumed" } })) === 1, `${chunkEvents.length} chunk events`);
  report("The file once more is a no-op", (await confirmImport(admin, body)).status === "ALREADY_IMPORTED" && (await prisma.patient.count({ where: { facilityId: fac.id } })) === ROWS);

  // 4. A re-import whose details differ.
  const p1 = await prisma.legacyRecordKey.findFirstOrThrow({ where: { facilityId: fac.id, kind: "PATIENT", sourceKey: mrn(1) } });
  const p2 = await prisma.legacyRecordKey.findFirstOrThrow({ where: { facilityId: fac.id, kind: "PATIENT", sourceKey: mrn(2) } });
  const p3 = await prisma.legacyRecordKey.findFirstOrThrow({ where: { facilityId: fac.id, kind: "PATIENT", sourceKey: mrn(3) } });
  const before = await prisma.patient.findMany({ where: { id: { in: [p1.targetId, p2.targetId, p3.targetId] } }, orderBy: { id: "asc" } });
  const reCsv = () => ["MRN,Name,Gender,DOB,Mobile", `${mrn(1)},Synthetic Person One Renamed,M,02/02/1941,9800000001`, `${mrn(2)},Synthetic Person 2,F,03/03/1942,9811112222`, `${mrn(3)},Synthetic Person 3,M,04/04/1943,9800000003`].join("\n");
  const re = { profile: { ...profile, encounters: undefined }, patientsCsv: reCsv() };
  const reDry = await dryRunImport(fac.id, re);
  report("A re-import: one identical row (a no-op), two that differ (for review), none created", reDry.counts.patients.toCreate === 0 && reDry.counts.patients.alreadyImported === 1 && reDry.counts.patients.toReview === 2, JSON.stringify(reDry.counts.patients));
  await confirmImport(admin, { ...re, dryRunHash: reDry.dryRunHash });
  const open = await listPatientReviews(fac.id);
  report("…the two differences wait for the hospital admin, with the fields that differ", open.length === 2 && open.find((r) => r.patientId === p1.targetId)?.differences.join(",") === "fullName" && open.find((r) => r.patientId === p2.targetId)?.differences.join(",") === "phone");
  const after = await prisma.patient.findMany({ where: { id: { in: [p1.targetId, p2.targetId, p3.targetId] } }, orderBy: { id: "asc" } });
  report("…and nothing was applied to the patients", JSON.stringify(after.map((p) => [p.fullName, p.phone])) === JSON.stringify(before.map((p) => [p.fullName, p.phone])));
  report("…each with its event", (await prisma.domainEventOutbox.count({ where: { facilityId: fac.id, eventType: "LegacyPatientReviewQueued" } })) === 2);
  const re2 = { profile: { ...profile, encounters: undefined }, patientsCsv: `${reCsv()}\n` };
  const reDry2 = await dryRunImport(fac.id, re2);
  await confirmImport(admin, { ...re2, dryRunHash: reDry2.dryRunHash });
  report("The same difference in another file is queued once", reDry2.counts.patients.toReview === 0 && (await prisma.legacyPatientReview.count({ where: { facilityId: fac.id } })) === 2, JSON.stringify(reDry2.counts.patients));

  // 5. Decisions.
  const r1 = open.find((r) => r.patientId === p1.targetId)!;
  const r2 = open.find((r) => r.patientId === p2.targetId)!;
  const noida = await prisma.user.create({ data: { email: `import-scale-noida-${tag}@verify.aarogya`, passwordHash: "x", role: "HOSPITAL_ADMIN", displayName: "Noida admin" } });
  report("A decision needs a reason", await refusedWith(decidePatientReview(admin, r1.id, { decision: "KEEP" }), "BadRequestError"));
  report("Another hospital's admin can't decide it (404)", await refusedWith(decidePatientReview({ userId: noida.id, facilityId: "fac-amc-noida" }, r1.id, { decision: "ACCEPT", reason: "x" }), "NotFoundError"));
  const kept = await decidePatientReview(admin, r1.id, { decision: "KEEP", reason: `The registration desk confirmed the current name ${tag}` });
  report("Keep: the existing details stay, recorded with the reason", kept.status === "KEPT" && (await prisma.patient.findUniqueOrThrow({ where: { id: p1.targetId } })).fullName === "Synthetic Person 1");
  await prisma.patient.update({ where: { id: p2.targetId }, data: { phone: "+919899999999" } });
  report("Accepting is refused when the patient changed since the review was queued", await refusedWith(decidePatientReview(admin, r2.id, { decision: "ACCEPT", reason: "new phone" }), "ConflictError") && (await prisma.legacyPatientReview.findUniqueOrThrow({ where: { id: r2.id } })).status === "OPEN");
  await prisma.patient.update({ where: { id: p2.targetId }, data: { phone: before.find((p) => p.id === p2.targetId)!.phone } });
  const accepted = await decidePatientReview(admin, r2.id, { decision: "ACCEPT", reason: `The patient confirmed the new number ${tag}` });
  const p2Now = await prisma.patient.findUniqueOrThrow({ where: { id: p2.targetId } });
  report("Accept: only the differing field changes", accepted.status === "ACCEPTED" && p2Now.phone === "+919811112222" && p2Now.fullName === "Synthetic Person 2");
  report("…both decisions audited with their reasons, and with their events",
    (await prisma.auditEvent.count({ where: { userId: user.id, type: { in: ["hospital.legacy-import.review.kept", "hospital.legacy-import.review.accepted"] } } })) === 2
    && (await prisma.domainEventOutbox.count({ where: { facilityId: fac.id, eventType: "LegacyPatientReviewDecided" } })) === 2);
  report("A decided review can't be decided again", await refusedWith(decidePatientReview(admin, r2.id, { decision: "KEEP", reason: "again" }), "ConflictError"));

  // 6. "Recorded by" on an imported visit.
  const visitPatient = (await prisma.legacyRecordKey.findFirstOrThrow({ where: { facilityId: fac.id, kind: "PATIENT", sourceKey: mrn(7) } })).targetId;
  const tl = await timelinePage(visitPatient, { kind: "STAFF", facilityId: fac.id });
  report("An imported visit says who recorded it in the old system", tl.entries.some((e) => e.summary.includes("Recorded by: Dr Legacy 1 (imported)")), tl.entries.find((e) => e.type === "Encounter")?.summary);

  console.log(`\n${pass} passed, ${fail} failed (${Math.round((Date.now() - t0) / 1000)} s)`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
