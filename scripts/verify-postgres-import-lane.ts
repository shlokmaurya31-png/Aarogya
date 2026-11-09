/**
 * Flagship 4c — the import lane's capacity (docs/EVENT_ARCHITECTURE.md §9).
 *
 *   1. A critical lab result with no backlog: the worker (runTick in a loop,
 *      as `npm run worker`) has its LabResultReleased handled, and the
 *      critical-result task open, within the budget.
 *   2. A 50,000-row import (one event per row, in the import lane), then the
 *      same: three critical results while the worker is busy clearing the
 *      backlog, each handled within the same budget, and the backlog was
 *      being cleared at the time.
 *   3. Capacity: the import lane clears faster at the default concurrency
 *      than one at a time (the Flagship 3 lane), measured over equal windows.
 *   4. The backlog clears completely with nothing dead-lettered; the time is
 *      reported.
 *   5. The setting: EVENT_IMPORT_LANE_CONCURRENCY 1–16, anything else the
 *      default.
 *
 * Runs in a facility of its own. Usage: through `npm run verify:all` (late:
 * it leaves an empty queue behind).
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";
import { confirmImport, dryRunImport } from "../src/lib/hospital/legacyImport/service";
import { enterResult, verifyResult } from "../src/lib/hospital/labResultLifecycle";
import { dispatchPendingDomainEvents, importLaneConcurrency, IMPORT_LANE_CONCURRENCY_DEFAULT } from "../src/lib/events/dispatcher";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { runTick } from "../src/lib/runner/tick";
import { tag } from "./lib/shareFixture";

const ROWS = 50_000;
/** A critical result's event is handled within this, backlog or not: one idle worker sleep (2 s) and one tick. */
const CRITICAL_BUDGET_MS = 5_000;
const WINDOW_MS = 20_000;

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const minutes = (ms: number) => `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;

/** The local worker's loop (scripts/worker.ts), until stopped. */
function startWorker() {
  let stopping = false;
  const done = (async () => {
    while (!stopping) {
      const r = await runTick({ budgetMs: 10_000 });
      const did = r.events.claimed + r.workflows.timersFired + r.workflows.instancesRun;
      if (!r.moreWork && !stopping) await sleep(did > 0 ? 250 : 2_000);
    }
  })();
  return { stop: async () => { stopping = true; await done; } };
}

async function main() {
  registerAllConsumers();
  // 5. The setting.
  report("EVENT_IMPORT_LANE_CONCURRENCY: 1–16 taken, anything else the default",
    importLaneConcurrency("1") === 1 && importLaneConcurrency("16") === 16 && [undefined, "", "0", "17", "2.5", "four", "-3"].every((v) => importLaneConcurrency(v) === IMPORT_LANE_CONCURRENCY_DEFAULT),
    `default ${IMPORT_LANE_CONCURRENCY_DEFAULT}, this run ${importLaneConcurrency()}`);

  const pune = await prisma.facility.findUniqueOrThrow({ where: { id: "fac-amc-pune" }, select: { organizationId: true } });
  const fac = await prisma.facility.create({ data: { name: `Import lane ${tag}`, organizationId: pune.organizationId } });
  const dept = await prisma.department.create({ data: { facilityId: fac.id, name: "General Medicine" } });
  const user = await prisma.user.create({ data: { email: `import-lane-${tag}@verify.aarogya`, passwordHash: "x", role: "HOSPITAL_ADMIN", displayName: "Import lane admin" } });
  const staff = await prisma.hospitalStaffProfile.create({ data: { userId: user.id, departmentId: dept.id, displayRole: "HOSPITAL_ADMIN" } });
  await ensurePrimaryMembership(prisma, user.id, fac.id, { isAdmin: true });
  const admin = { userId: user.id, facilityId: fac.id };
  const patient = await prisma.patient.create({ data: { facilityId: fac.id, uhid: `UHID-LANE-${tag}`, fullName: `Lane Patient ${tag}`, sex: "F" } });
  const enc = await prisma.encounter.create({ data: { patientId: patient.id, facilityId: fac.id, type: "OPD", status: "IN_CONSULTATION", attendingStaffId: staff.id } });

  const bulkWaiting = () => prisma.domainEventOutbox.count({ where: { bulk: true, status: { in: ["PENDING", "RETRY", "PROCESSING"] } } });
  /** A critical result through the real lifecycle; ms until its LabResultReleased is handled and its task is open. */
  const criticalResult = async () => {
    const order = await prisma.labOrder.create({ data: { encounterId: enc.id, patientId: patient.id, testName: "Potassium", category: "Chemistry", orderedByStaffId: staff.id } });
    const res = await prisma.$transaction((tx) => enterResult(tx, { labOrderId: order.id, value: "7.1", unit: "mmol/L", numericValue: 7.1, isCritical: true }));
    const t0 = Date.now();
    await prisma.$transaction((tx) => verifyResult(tx, res.id, staff.id, user.id));
    const evt = await prisma.domainEventOutbox.findFirstOrThrow({ where: { eventType: "LabResultReleased", aggregateId: res.id } });
    for (;;) {
      const e = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { id: evt.id }, select: { status: true } });
      if (e.status === "PROCESSED" && (await prisma.task.count({ where: { idempotencyKey: { contains: res.id } } })) > 0) return { ms: Date.now() - t0, bulk: evt.bulk };
      if (Date.now() - t0 > 60_000) return { ms: Infinity, bulk: evt.bulk };
      await sleep(25);
    }
  };

  // Start from an empty live lane (earlier gates' leftovers).
  for (let i = 0; i < 100; i++) if ((await dispatchPendingDomainEvents({ batchSize: 500, maxDurationMs: 10_000 })).claimed === 0) break;

  // 1. No backlog.
  let worker = startWorker();
  await sleep(500);
  const idle = [await criticalResult(), await criticalResult()];
  await worker.stop();
  const idleMax = Math.max(...idle.map((r) => r.ms));
  report(`No backlog: a critical result is handled within ${CRITICAL_BUDGET_MS / 1000} s, in the live lane`, idleMax <= CRITICAL_BUDGET_MS && idle.every((r) => !r.bulk), idle.map((r) => `${r.ms} ms`).join(", "));

  // 2. A 50,000-row backlog.
  const profile = { sourceSystem: `LANE-${tag}`, dateFormat: "DD/MM/YYYY", patients: { columns: { mrn: "MRN", fullName: "Name", sex: "Gender", dob: "DOB" }, sex: { M: "M", F: "F" } } };
  const patientsCsv = ["MRN,Name,Gender,DOB", ...Array.from({ length: ROWS }, (_, i) => `L${String(i).padStart(6, "0")},Synthetic Lane ${i},${i % 2 ? "M" : "F"},${String(1 + (i % 28)).padStart(2, "0")}/${String(1 + (i % 12)).padStart(2, "0")}/${1940 + (i % 60)}`)].join("\n");
  const tImport = Date.now();
  const dry = await dryRunImport(fac.id, { profile, patientsCsv });
  const run = await confirmImport(admin, { profile, patientsCsv, dryRunHash: dry.dryRunHash });
  const backlog = await bulkWaiting();
  report(`A ${ROWS.toLocaleString("en-IN")}-row import leaves its events waiting in the import lane`, run.status === "COMMITTED" && backlog >= ROWS, `${backlog.toLocaleString("en-IN")} waiting after ${Math.round((Date.now() - tImport) / 1000)} s`);

  // 3. Capacity: equal windows, one at a time (Flagship 3's lane) vs the default.
  const rate = async (importConcurrency: number) => {
    const before = await bulkWaiting();
    const t = Date.now();
    while (Date.now() - t < WINDOW_MS) await dispatchPendingDomainEvents({ batchSize: 100, maxDurationMs: 2_000, importConcurrency });
    return (before - (await bulkWaiting())) / ((Date.now() - t) / 1000);
  };
  const sequential = await rate(1);
  const concurrent = await rate(importLaneConcurrency());
  report(`The import lane clears faster at concurrency ${importLaneConcurrency()} than one at a time`, concurrent > sequential * 1.3,
    `${sequential.toFixed(0)} vs ${concurrent.toFixed(0)} events/s; ${ROWS.toLocaleString("en-IN")} rows ≈ ${minutes((ROWS / sequential) * 1000)} vs ${minutes((ROWS / concurrent) * 1000)}`);

  // 2 (cont). Critical results while the worker clears the backlog.
  worker = startWorker();
  const tDrain = Date.now();
  const atStart = await bulkWaiting();
  await sleep(3_000);
  const busy = [];
  for (let i = 0; i < 3; i++) {
    const before = await bulkWaiting();
    const r = await criticalResult();
    busy.push({ ...r, cleared: before - (await bulkWaiting()) });
    await sleep(1_000);
  }
  const busyMax = Math.max(...busy.map((r) => r.ms));
  report(`During the backlog: each critical result is handled within the same ${CRITICAL_BUDGET_MS / 1000} s budget`, busyMax <= CRITICAL_BUDGET_MS && busy.every((r) => !r.bulk), busy.map((r) => `${r.ms} ms`).join(", ") + ` (no backlog: ${idleMax} ms)`);
  report("…while the backlog was being cleared", busy.every((r) => r.cleared > 0) && (await bulkWaiting()) > 0, busy.map((r) => `${r.cleared} cleared meanwhile`).join(", "));

  // 4. The backlog clears completely.
  while ((await bulkWaiting()) > 0 && Date.now() - tDrain < 25 * 60_000) await sleep(2_000);
  await worker.stop();
  const left = await bulkWaiting();
  const drainMs = Date.now() - tDrain;
  const dead = await prisma.domainEventOutbox.count({ where: { facilityId: fac.id, status: "DEAD_LETTER" } });
  report("The backlog clears completely, nothing dead-lettered", left === 0 && dead === 0, `${atStart.toLocaleString("en-IN")} events cleared by the worker in ${minutes(drainMs)} (${(atStart / (drainMs / 1000)).toFixed(0)} events/s); ${left} left, ${dead} dead-lettered`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
