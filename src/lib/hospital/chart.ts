import type { MedicationOrderStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";

/**
 * Flagship 2d — the chart in pages (it was every encounter with its
 * admission, bed and ward, plus 50 of each order with up to 20
 * administrations and dispensings apiece: 451 KB for a year-long inpatient).
 *
 *   - The summary header: counts per section, every allergy, the problem
 *     list, every CURRENT medication order and every critical lab result or
 *     imaging finding not yet acknowledged (nothing that needs acting on may
 *     fall off a page), the latest vitals, care plans and recent handoffs.
 *   - Each section in pages, newest first, by an opaque cursor: the first
 *     load carries CHART_FIRST_PAGE of each (about 50 items in all), "load
 *     more" asks for CHART_PAGE_SIZE.
 *
 * Staff appear by display name only (never a User row).
 */
export const CHART_SECTIONS = ["encounters", "notes", "vitals", "medicationOrders", "labOrders", "imagingOrders", "diagnoses"] as const;
export type ChartSection = (typeof CHART_SECTIONS)[number];
export const CHART_FIRST_PAGE = 8;
export const CHART_PAGE_SIZE = 50;
const CURRENT_MEDICATION: MedicationOrderStatus[] = ["ORDERED", "PHARMACY_REVIEW", "VERIFIED", "DISPENSED", "ACTIVE", "HELD"];
const NAME = { select: { user: { select: { displayName: true } } } } as const;
const LAB_SELECT = {
  id: true, encounterId: true, testName: true, status: true, orderedAt: true,
  results: { where: { isCurrent: true }, select: { id: true, value: true, unit: true, isCritical: true, acknowledgedAt: true, version: true, abnormalFlag: true, status: true } },
  specimens: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, accessionNumber: true, status: true } },
} as const;
const IMAGING_SELECT = {
  id: true, encounterId: true, modality: true, studyDescription: true, status: true, orderedAt: true,
  reports: { where: { isCurrent: true }, select: { id: true, impression: true, isCritical: true, verifiedAt: true, acknowledgedAt: true, version: true } },
  studies: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, accessionNumber: true, status: true } },
} as const;

type Range = { lt: Date } | { equals: Date } | null;
interface Cursor { t: string; id: string }

function encodeCursor(t: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: t.toISOString(), id })).toString("base64url");
}
function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (typeof c.t === "string" && typeof c.id === "string" && !Number.isNaN(Date.parse(c.t))) return c;
  } catch { /* refused below */ }
  throw new BadRequestError("Invalid cursor.");
}

/** How each section is read: its own time, and the slim shape the screens use. */
function sectionQuery(section: ChartSection, patientId: string) {
  const enc = { encounter: { patientId } };
  const at = (r: Range) => r ?? {};
  switch (section) {
    case "encounters": return { time: "registeredAt" as const, fetch: (r: Range, take?: number) => prisma.encounter.findMany({
      where: { patientId, registeredAt: at(r) }, orderBy: [{ registeredAt: "desc" }, { id: "asc" }], take,
      select: {
        id: true, type: true, status: true, chiefComplaint: true, registeredAt: true, closedAt: true,
        department: { select: { name: true } }, attendingStaff: NAME,
        admission: { select: { id: true, admittedAt: true, bed: { select: { label: true, ward: { select: { name: true } } } }, discharge: { select: { dischargedAt: true } } } },
      },
    }) };
    case "notes": return { time: "createdAt" as const, fetch: (r: Range, take?: number) => prisma.clinicalNote.findMany({
      where: { ...enc, createdAt: at(r) }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take,
      select: { id: true, encounterId: true, type: true, status: true, content: true, createdAt: true, author: NAME },
    }) };
    case "vitals": return { time: "recordedAt" as const, fetch: (r: Range, take?: number) => prisma.vital.findMany({ where: { ...enc, recordedAt: at(r) }, orderBy: [{ recordedAt: "desc" }, { id: "asc" }], take }) };
    case "medicationOrders": return { time: "orderedAt" as const, fetch: (r: Range, take?: number) => prisma.medicationOrder.findMany({
      where: { ...enc, orderedAt: at(r) }, orderBy: [{ orderedAt: "desc" }, { id: "asc" }], take,
      select: { id: true, encounterId: true, drugName: true, dose: true, route: true, frequency: true, status: true, orderedAt: true, isControlled: true, orderedBy: NAME, safetyWarnings: { select: { id: true, severity: true, message: true, acknowledgedAt: true } } },
    }) };
    case "labOrders": return { time: "orderedAt" as const, fetch: (r: Range, take?: number) => prisma.labOrder.findMany({
      where: { ...enc, orderedAt: at(r) }, orderBy: [{ orderedAt: "desc" }, { id: "asc" }], take, select: LAB_SELECT,
    }) };
    case "imagingOrders": return { time: "orderedAt" as const, fetch: (r: Range, take?: number) => prisma.imagingOrder.findMany({
      where: { ...enc, orderedAt: at(r) }, orderBy: [{ orderedAt: "desc" }, { id: "asc" }], take, select: IMAGING_SELECT,
    }) };
    case "diagnoses": return { time: "createdAt" as const, fetch: (r: Range, take?: number) => prisma.diagnosis.findMany({ where: { ...enc, createdAt: at(r) }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], take }) };
  }
}

/**
 * One page of a section, newest first (at the same moment, by id in
 * code-unit order). Exact: rows at the cursor's moment, and at the page's
 * cut, are read whole and ordered in memory.
 */
export async function chartSectionPage(patientId: string, section: ChartSection, opts: { cursor?: string | null; limit?: number } = {}) {
  const limit = Math.min(Math.max(1, opts.limit ?? CHART_PAGE_SIZE), 200);
  const cursor = decodeCursor(opts.cursor);
  const q = sectionQuery(section, patientId);
  type Row = Awaited<ReturnType<typeof q.fetch>>[number] & { id: string };
  const timeOf = (row: Row) => (row as unknown as Record<string, Date>)[q.time];
  const fetch = (r: Range, take?: number) => q.fetch(r, take) as Promise<Row[]>;
  const before = (row: Row) => !cursor || timeOf(row).toISOString() < cursor.t || (timeOf(row).toISOString() === cursor.t && row.id > cursor.id);
  let rows: Row[] = cursor ? [...(await fetch({ equals: new Date(cursor.t) })), ...(await fetch({ lt: new Date(cursor.t) }, limit + 1))] : await fetch(null, limit + 1);
  if (rows.length > limit) {
    const last = timeOf(rows[rows.length - 1]);
    const seen = new Set(rows.map((r) => r.id));
    rows = [...rows, ...(await fetch({ equals: last })).filter((r) => !seen.has(r.id))];
  }
  const ordered = rows.filter(before).sort((a, b) => {
    const ta = timeOf(a).getTime(), tb = timeOf(b).getTime();
    return tb - ta || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  const items = ordered.slice(0, limit);
  const lastItem = items[items.length - 1];
  return { items, nextCursor: ordered.length > limit && lastItem ? encodeCursor(timeOf(lastItem), lastItem.id) : null };
}

/** The summary header, and every section's first page. */
export async function chartFirstPage(patientId: string) {
  const enc = { encounter: { patientId } };
  const [allergies, problems, currentMedications, criticalLabs, criticalImaging, latestVitals, carePlans, handoffs, counts] = await Promise.all([
    prisma.allergy.findMany({ where: { patientId }, orderBy: { recordedAt: "desc" } }),
    prisma.problem.findMany({ where: { patientId }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.medicationOrder.findMany({
      where: { ...enc, status: { in: CURRENT_MEDICATION } }, orderBy: [{ orderedAt: "desc" }, { id: "asc" }], take: 200,
      select: { id: true, encounterId: true, drugName: true, dose: true, route: true, frequency: true, status: true, orderedAt: true, isControlled: true, safetyWarnings: { select: { id: true, severity: true, message: true, acknowledgedAt: true } } },
    }),
    prisma.labOrder.findMany({ where: { ...enc, results: { some: { isCurrent: true, isCritical: true, acknowledgedAt: null } } }, orderBy: [{ orderedAt: "desc" }, { id: "asc" }], take: 100, select: LAB_SELECT }),
    prisma.imagingOrder.findMany({ where: { ...enc, reports: { some: { isCurrent: true, isCritical: true, acknowledgedAt: null } } }, orderBy: [{ orderedAt: "desc" }, { id: "asc" }], take: 100, select: IMAGING_SELECT }),
    prisma.vital.findFirst({ where: enc, orderBy: { recordedAt: "desc" } }),
    prisma.carePlan.findMany({ where: { patientId }, include: { interventions: { orderBy: { createdAt: "desc" }, take: 20 } }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.clinicalHandoff.findMany({ where: { patientId }, include: { fromStaff: NAME, toStaff: NAME }, orderBy: { createdAt: "desc" }, take: 10 }),
    Promise.all([
      prisma.encounter.count({ where: { patientId } }),
      prisma.clinicalNote.count({ where: enc }),
      prisma.vital.count({ where: enc }),
      prisma.medicationOrder.count({ where: enc }),
      prisma.labOrder.count({ where: enc }),
      prisma.imagingOrder.count({ where: enc }),
      prisma.diagnosis.count({ where: enc }),
    ]),
  ]);
  const pages = await Promise.all(CHART_SECTIONS.map((s) => chartSectionPage(patientId, s, { limit: CHART_FIRST_PAGE })));
  const sections = Object.fromEntries(CHART_SECTIONS.map((s, i) => [s, pages[i].items])) as { [K in ChartSection]: Awaited<ReturnType<typeof chartSectionPage>>["items"] };
  return {
    summary: {
      counts: Object.fromEntries(CHART_SECTIONS.map((s, i) => [s, counts[i]])) as Record<ChartSection, number>,
      currentMedicationOrders: currentMedications,
      unacknowledgedCritical: { labOrders: criticalLabs, imagingOrders: criticalImaging },
      latestVitals,
    },
    allergies, problems, carePlans, handoffs,
    ...sections,
    nextCursors: Object.fromEntries(CHART_SECTIONS.map((s, i) => [s, pages[i].nextCursor])) as Record<ChartSection, string | null>,
  };
}
