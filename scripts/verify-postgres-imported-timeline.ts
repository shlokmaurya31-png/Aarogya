/**
 * Flagship 4b — imported results in the chart's timeline, behind "show
 * imported" (docs/LEGACY_IMPORT_DESIGN.md §11.4).
 *
 *   1. Off by default: a patient's HL7-imported results are not in the
 *      timeline.
 *   2. The preference is the user's own: turning it on emits
 *      ChartPreferenceChanged in the same transaction (once: setting it again
 *      is no change), and another user's stays off. Anything but true/false is
 *      refused.
 *   3. On: the results are in the timeline in time order, each labelled
 *      imported and "not verified here", and paging stays exact with them.
 *   4. Never anywhere else: not in the patient's or a proxy's feed (even with
 *      the flag passed), not in the whole-feed builder other callers use, no
 *      LabResult, no critical flag, no release event, whatever the setting.
 *   5. Over HTTP (next start): the timeline route reads the signed-in user's
 *      own setting; PUT /api/hospital/chart-preferences changes it.
 *
 * Synthetic HL7 at the seeded Pune facility. Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { ensurePrimaryMembership } from "../prisma/seedData/staffMembership";
import { confirmImport, dryRunImport } from "../src/lib/hospital/legacyImport/service";
import { chartPreferences, setShowImportedResults } from "../src/lib/hospital/chartPreferences";
import { buildPatientTimeline, timelinePage, type TimelineEntry } from "../src/lib/patient/timeline";
import { startServer, loginAs } from "./lib/appServer";
import { tag } from "./lib/shareFixture";

const PUNE = "fac-amc-pune";
const STAFF_PASSWORD = "Hospital@123";
let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const refusedWith = <T>(p: Promise<T>, name: string) => p.then(() => false, (e) => (e as Error).constructor.name === name);
const seg = (name: string, f: Record<number, string>) => [name, ...Array.from({ length: Math.max(...Object.keys(f).map(Number)) }, (_, i) => f[i + 1] ?? "")].join("|");

async function main() {
  const dept = await prisma.department.findFirstOrThrow({ where: { facilityId: PUNE }, select: { id: true } });
  const staffUser = async (label: string, role: "HOSPITAL_ADMIN" | "DOCTOR") => {
    const u = await prisma.user.create({ data: { email: `imported-tl-${label}-${tag}@verify.aarogya`, passwordHash: "x", role, displayName: `Timeline ${label}` } });
    await prisma.hospitalStaffProfile.create({ data: { userId: u.id, departmentId: dept.id, displayRole: role } });
    await ensurePrimaryMembership(prisma, u.id, PUNE, { isAdmin: role === "HOSPITAL_ADMIN" });
    return u;
  };
  const admin = await staffUser("admin", "HOSPITAL_ADMIN");
  const docA = await staffUser("doctor-a", "DOCTOR");
  const docB = await staffUser("doctor-b", "DOCTOR");

  // A patient with two imported results, then a live visit and a live result.
  const y = new Date().getUTCFullYear() - 1;
  const S = `TLHIMS-${tag}`;
  const profile = { sourceSystem: S, format: "HL7V2", mrnIdentifierType: "MR", sex: { M: "M", F: "F" }, patientClass: { O: "OPD" }, departments: {}, results: { tests: { HGB: { name: "Haemoglobin", unit: "g/dL" }, CRP: { name: "CRP", unit: "mg/L" } } } };
  const pid = seg("PID", { 1: "1", 3: `TL1-${tag}^^^PUNE^MR`, 5: `Timeline^Imported${tag}`, 7: "19800312", 8: "F" });
  const hl7 = [
    `MSH|^~\\&|OLDHIMS|PUNE|AAROGYA|PUNE|${y}0301090000||ADT^A04|T1|P|2.5`, pid,
    `MSH|^~\\&|OLDHIMS|PUNE|AAROGYA|PUNE|${y}0402090000||ORU^R01|T2|P|2.5`, pid, seg("OBR", { 1: "1", 3: `TL-${tag}-1` }),
    seg("OBX", { 1: "1", 2: "NM", 3: "HGB^HGB^LOCAL", 5: "11.2", 6: "g/dL", 8: "L", 11: "F", 14: `${y}0402090000` }),
    seg("OBX", { 1: "2", 2: "NM", 3: "CRP^CRP^LOCAL", 5: "48", 6: "mg/L", 8: "HH", 11: "F", 14: `${y}0403100000` }),
  ].join("\r");
  const dry = await dryRunImport(PUNE, { profile, hl7 });
  const run = await confirmImport({ userId: admin.id, facilityId: PUNE }, { profile, hl7, dryRunHash: dry.dryRunHash });
  const key = await prisma.legacyRecordKey.findFirstOrThrow({ where: { facilityId: PUNE, sourceSystem: S, kind: "PATIENT" } });
  const patientId = key.targetId;
  const docAStaff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { userId: docA.id } });
  const enc = await prisma.encounter.create({ data: { patientId, facilityId: PUNE, type: "OPD", status: "IN_CONSULTATION", chiefComplaint: `Follow-up ${tag}` } });
  const order = await prisma.labOrder.create({ data: { encounterId: enc.id, patientId, testName: "Hemoglobin", category: "Hematology", orderedByStaffId: docAStaff.id } });
  await prisma.labResult.create({ data: { labOrderId: order.id, value: "12.1", unit: "g/dL", status: "ENTERED", resultedAt: new Date() } });
  report("Setup: an HL7 import with two results, and a live visit with a live result", run.status === "COMMITTED" && (await prisma.legacyLabResult.count({ where: { patientId } })) === 2);

  const staff = { kind: "STAFF" as const, facilityId: PUNE };
  const isImported = (e: TimelineEntry) => e.sourceType === "LegacyLabResult";
  const whole = async (includeImported: boolean, limit = 1) => {
    const out: TimelineEntry[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 200; i++) {
      const p: { entries: TimelineEntry[]; nextCursor: string | null } = await timelinePage(patientId, staff, { cursor, limit, includeImported });
      out.push(...p.entries);
      cursor = p.nextCursor;
      if (!cursor) break;
    }
    return out;
  };
  const sideEffects = async () => JSON.stringify({
    labResults: await prisma.labResult.count({ where: { labOrder: { patientId } } }),
    critical: await prisma.labResult.count({ where: { labOrder: { patientId }, isCritical: true } }),
    released: await prisma.domainEventOutbox.count({ where: { facilityId: PUNE, eventType: { in: ["LabResultReleased", "LabResultVerified", "CriticalResultRaised"] }, payload: { path: ["patientId"], equals: patientId } } }),
    tasks: await prisma.task.count({ where: { patientId } }),
  });
  const before = await sideEffects();

  // 1. Off by default.
  report("Off by default, for every user", !(await chartPreferences(docA.id)).showImportedResults && !(await chartPreferences(docB.id)).showImportedResults);
  const off = (await timelinePage(patientId, staff, { includeImported: false })).entries;
  report("…and the timeline has no imported results", off.length > 0 && !off.some(isImported), `${off.length} entries`);

  // 2. The user's own preference, with its event.
  report("Anything but true/false is refused", await refusedWith(setShowImportedResults({ userId: docA.id, facilityId: PUNE }, { showImportedResults: "yes" }), "BadRequestError"));
  await setShowImportedResults({ userId: docA.id, facilityId: PUNE }, { showImportedResults: true });
  await setShowImportedResults({ userId: docA.id, facilityId: PUNE }, { showImportedResults: true });
  const events = await prisma.domainEventOutbox.findMany({ where: { aggregateId: docA.id, eventType: "ChartPreferenceChanged" }, select: { payload: true, aggregateType: true } });
  report("Turning it on is remembered and emits ChartPreferenceChanged, once (the second time is no change)", (await chartPreferences(docA.id)).showImportedResults && events.length === 1 && (events[0].payload as { showImportedResults: boolean }).showImportedResults === true && events[0].aggregateType === "CHART_PREFERENCE");
  report("…for that user only", !(await chartPreferences(docB.id)).showImportedResults);

  // 3. On: in the timeline, labelled, paging exact.
  const on = (await timelinePage(patientId, staff, { includeImported: true, limit: 200 })).entries;
  const imported = on.filter(isImported);
  report("On: both imported results are in the timeline, labelled imported and not verified here",
    imported.length === 2 && imported.every((e) => e.imported === true && e.type === "Result" && /^Imported result: /.test(e.summary) && /not verified here/.test(e.summary)),
    imported.map((e) => e.summary).join(" | "));
  report("…with the old system's flag and the live entries alongside", imported.some((e) => e.summary.includes("CRP 48 mg/L (flag HH)")) && on.some((e) => e.sourceType === "LabResult") && on.length === off.length + 2);
  const paged = await whole(true, 1);
  report("…and paging one entry at a time gives exactly the same feed", JSON.stringify(paged.map((e) => e.id)) === JSON.stringify(on.map((e) => e.id)), `${paged.length} vs ${on.length}`);
  const sorted = [...on].sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : a.id < b.id ? -1 : 1));
  report("…in time order, newest first", JSON.stringify(sorted.map((e) => e.id)) === JSON.stringify(on.map((e) => e.id)));

  // 4. Never anywhere else.
  const patientSide = (await timelinePage(patientId, { kind: "PATIENT" }, { includeImported: true, limit: 200 })).entries;
  const proxySide = (await timelinePage(patientId, { kind: "PROXY" }, { includeImported: true, limit: 200 })).entries;
  report("Not in the patient's or a proxy's feed, even asked for", patientSide.length > 0 && !patientSide.some(isImported) && !proxySide.some(isImported));
  report("Not in the whole-feed builder (the patient app, summaries, the AI)", !(await buildPatientTimeline(patientId, staff)).some(isImported));
  report("No LabResult, critical flag, release or task from them, whatever the setting", (await sideEffects()) === before, before);

  // 5. Over HTTP: the route reads the signed-in user's own setting.
  const { base, child, serverLog } = await startServer();
  const doctor1 = await prisma.user.findUniqueOrThrow({ where: { email: "doctor1@amc-demo.aarogya" }, select: { id: true, showImportedResults: true } });
  try {
    const d1 = await loginAs(base, "doctor1@amc-demo.aarogya", STAFF_PASSWORD);
    const nurse = await loginAs(base, "nurse1@amc-demo.aarogya", STAFF_PASSWORD);
    const timeline = async (cookie: string) => {
      const r = await fetch(`${base}/api/hospital/patients/${patientId}/timeline?limit=200`, { headers: { cookie } });
      const j = (await r.json()) as { timeline?: TimelineEntry[]; showImportedResults?: boolean };
      return { status: r.status, imported: (j.timeline ?? []).filter(isImported).length, show: j.showImportedResults };
    };
    const put = (cookie: string, body: unknown) => fetch(`${base}/api/hospital/chart-preferences`, { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
    await put(d1, { showImportedResults: false });
    const t0 = await timeline(d1);
    report("HTTP: off, the timeline route sends no imported results and says so", t0.status === 200 && t0.imported === 0 && t0.show === false, JSON.stringify(t0));
    const bad = await put(d1, { showImportedResults: 1 });
    const on1 = await put(d1, { showImportedResults: true });
    const t1 = await timeline(d1);
    const tn = await timeline(nurse);
    report("HTTP: PUT turns it on for the caller: their timeline has both, another user's has none", bad.status === 400 && on1.status === 200 && t1.imported === 2 && t1.show === true && tn.status === 200 && tn.imported === 0 && tn.show === false, `${bad.status} ${on1.status} ${JSON.stringify(t1)} ${JSON.stringify(tn)}`);
    const pref = await fetch(`${base}/api/hospital/chart-preferences`, { headers: { cookie: d1 } });
    const prefBody = await pref.text();
    report("HTTP: GET returns only the preference", pref.status === 200 && prefBody === JSON.stringify({ showImportedResults: true }), prefBody);
  } catch (e) {
    console.error(serverLog().slice(-3000));
    throw e;
  } finally {
    // The seeded doctor is shared with other gates: put their setting back.
    await prisma.user.update({ where: { id: doctor1.id }, data: { showImportedResults: doctor1.showImportedResults } });
    child.kill("SIGTERM");
  }

  await setShowImportedResults({ userId: docA.id, facilityId: PUNE }, { showImportedResults: false });
  report("Turning it off hides them again, with its event", !(await timelinePage(patientId, staff, { includeImported: (await chartPreferences(docA.id)).showImportedResults, limit: 200 })).entries.some(isImported)
    && (await prisma.domainEventOutbox.count({ where: { aggregateId: docA.id, eventType: "ChartPreferenceChanged" } })) === 2);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
