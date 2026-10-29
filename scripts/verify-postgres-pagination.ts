/**
 * Flagship 2d — the chart and the timeline in pages, exactly.
 *
 *   1. Walking the timeline page by page (a small page size, so there are
 *      many) yields exactly the whole feed in order: nothing skipped,
 *      nothing twice. The fixture is built to break a naive cursor: runs of
 *      entries at the same moment, rows whose later entries (a result
 *      verified and amended long after it was entered) belong to later
 *      pages, and two streams whose prefixes overlap (encounter /
 *      encounter-closed).
 *   2. The same for every chart section, against a plain ordered query.
 *   3. A critical result not yet acknowledged, on an order far down the
 *      lab list, is in the chart's summary header; so is a current
 *      medication order that is not on the first page.
 *   4. A malformed cursor is refused (never read as "from the start").
 * The pages' sizes over HTTP are perf:gate's (chart and timeline first and
 * next pages, under 60 KB for the heavy patient).
 *
 * Usage: through `npm run verify:all`.
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { buildPatientTimeline, timelinePage } from "../src/lib/patient/timeline";
import { CHART_SECTIONS, chartFirstPage, chartSectionPage } from "../src/lib/hospital/chart";
import { tag } from "./lib/shareFixture";

const PUNE = "fac-amc-pune";
let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function main() {
  const staff = await prisma.hospitalStaffProfile.findFirstOrThrow({ where: { user: { email: "doctor1@amc-demo.aarogya" } }, select: { id: true } });
  const patient = await prisma.patient.create({ data: { uhid: `PG-${tag}`, facilityId: PUNE, fullName: `Paging Patient ${tag}`, sex: "F" } });
  const base = Date.parse("2026-03-01T04:00:00Z");
  const at = (minutes: number) => new Date(base + minutes * 60_000);

  // 12 encounters, three registered at the very same moment, most closed later.
  const encounters = [];
  for (let i = 0; i < 12; i++) {
    const registeredAt = at(i < 3 ? 0 : i * 600);
    encounters.push(await prisma.encounter.create({ data: { patientId: patient.id, facilityId: PUNE, type: "OPD", status: i % 4 === 0 ? "REGISTERED" : "CLOSED", registeredAt, closedAt: i % 4 === 0 ? null : new Date(registeredAt.getTime() + 45 * 60_000) } }));
  }
  const e0 = encounters[11];
  // 30 lab orders: the oldest has a CRITICAL result never acknowledged; results entered,
  // some verified and amended days later; a run of five orders at one moment.
  const labIds: string[] = [];
  for (let i = 0; i < 30; i++) {
    const orderedAt = at(i < 5 ? 3000 : 3000 + i * 90);
    const o = await prisma.labOrder.create({ data: { encounterId: e0.id, patientId: patient.id, testName: `Test ${i}`, category: "CHEMISTRY", orderedByStaffId: staff.id, orderedAt, status: "RESULTED" } });
    labIds.push(o.id);
    await prisma.labResult.create({ data: {
      labOrderId: o.id, value: String(i), resultedAt: new Date(orderedAt.getTime() + 30 * 60_000), isCritical: i === 0, isCurrent: true,
      verifiedAt: i % 3 === 0 ? new Date(orderedAt.getTime() + 5 * 86_400_000) : null,
      amendedAt: i % 7 === 0 ? new Date(orderedAt.getTime() + 9 * 86_400_000) : null, amendedReason: i % 7 === 0 ? "gate" : null,
    } });
  }
  // 20 vitals, 10 at one moment; 15 medication orders, the oldest still ACTIVE.
  for (let i = 0; i < 20; i++) await prisma.vital.create({ data: { encounterId: e0.id, recordedByStaffId: staff.id, recordedAt: at(i < 10 ? 5000 : 5000 + i * 7), hr: 60 + i } });
  const meds: string[] = [];
  for (let i = 0; i < 15; i++) {
    const m = await prisma.medicationOrder.create({ data: { encounterId: e0.id, patientId: patient.id, orderedByStaffId: staff.id, drugName: `Drug ${i}`, dose: "1 tab", route: "PO", frequency: "OD", status: i === 0 ? "ACTIVE" : "COMPLETED", orderedAt: at(6000 + i * 11) } });
    meds.push(m.id);
  }

  // 1. The timeline, walked.
  const viewer = { kind: "STAFF" as const, facilityId: PUNE };
  const whole = await buildPatientTimeline(patient.id, viewer);
  for (const limit of [7, 13, 50]) {
    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof timelinePage>> = await timelinePage(patient.id, viewer, { cursor, limit });
      walked.push(...page.entries.map((e) => e.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 500);
    report(`Timeline in pages of ${limit}: every entry exactly once, in feed order (${pages} pages)`, walked.join() === whole.map((e) => e.id).join() && new Set(walked).size === walked.length, `${walked.length} walked, ${whole.length} in the feed`);
  }
  report("The fixture really has ties and late entries", whole.filter((e) => e.timestamp === at(0).toISOString()).length >= 3 && whole.some((e) => e.id.startsWith("result-amended-")) && whole.some((e) => e.id.startsWith("encounter-closed-")));

  // 2. Every chart section, walked, against a plain ordered read.
  const plain: Record<string, string[]> = {
    encounters: (await prisma.encounter.findMany({ where: { patientId: patient.id }, select: { id: true, registeredAt: true } })).sort((a, b) => b.registeredAt.getTime() - a.registeredAt.getTime() || (a.id < b.id ? -1 : 1)).map((r) => r.id),
    labOrders: (await prisma.labOrder.findMany({ where: { encounter: { patientId: patient.id } }, select: { id: true, orderedAt: true } })).sort((a, b) => b.orderedAt.getTime() - a.orderedAt.getTime() || (a.id < b.id ? -1 : 1)).map((r) => r.id),
    vitals: (await prisma.vital.findMany({ where: { encounter: { patientId: patient.id } }, select: { id: true, recordedAt: true } })).sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime() || (a.id < b.id ? -1 : 1)).map((r) => r.id),
    medicationOrders: (await prisma.medicationOrder.findMany({ where: { encounter: { patientId: patient.id } }, select: { id: true, orderedAt: true } })).sort((a, b) => b.orderedAt.getTime() - a.orderedAt.getTime() || (a.id < b.id ? -1 : 1)).map((r) => r.id),
  };
  for (const section of CHART_SECTIONS) {
    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof chartSectionPage>> = await chartSectionPage(patient.id, section, { cursor, limit: 4 });
      walked.push(...page.items.map((r) => (r as { id: string }).id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 500);
    const expected = plain[section];
    if (expected) report(`Chart ${section} in pages of 4: every row exactly once, newest first`, walked.join() === expected.join(), `${walked.length} of ${expected.length}`);
    else report(`Chart ${section} in pages: no row twice`, new Set(walked).size === walked.length, `${walked.length}`);
  }

  // 3. What needs acting on is never off the first page.
  const first = await chartFirstPage(patient.id);
  report("The first chart page holds a few of each section, not the whole record", first.labOrders.length <= 8 && first.nextCursors.labOrders !== null && first.summary.counts.labOrders === 30, `${first.labOrders.length} of ${first.summary.counts.labOrders}`);
  report("An unacknowledged critical result on the oldest order is in the summary header", first.summary.unacknowledgedCritical.labOrders.some((o) => o.id === labIds[0]) && !first.labOrders.some((o) => o.id === labIds[0]));
  report("A current medication order that is not on the first page is in the summary header", first.summary.currentMedicationOrders.some((m) => m.id === meds[0]) && !first.medicationOrders.some((m) => m.id === meds[0]));
  report("Staff appear by name only in the chart (no User row)", !JSON.stringify(first).includes("passwordHash") && !JSON.stringify(first).includes("tokenVersion"));

  // 4. A bad cursor is refused, not read as the start.
  let refused = false;
  try { await chartSectionPage(patient.id, "labOrders", { cursor: "not-a-cursor" }); } catch { refused = true; }
  report("A malformed chart cursor is refused", refused);

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
