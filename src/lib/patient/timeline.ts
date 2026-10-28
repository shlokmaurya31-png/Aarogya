import { prisma } from "@/lib/db";
import { resolvePatientIdsForRead } from "./merge";
import { TRANSFER_WITH_LOCATIONS, transferRouteLabel } from "@/lib/hospital/admission";
import { documentVisibilityFor, personDocumentsFor, type DocumentViewer } from "@/lib/person/access";
import { describePatientProvided, patientProvidedRecordsFor } from "@/lib/documents/merge";

/**
 * The longitudinal timeline (brief §32) is built by reading every typed
 * table and merging into one sorted feed at request time — not by
 * maintaining a separate ClinicalEvent table that duplicates the same
 * data. This is a deliberate architectural choice: a generic event table
 * would become a second source of truth that could drift from the real
 * rows (see docs/CLINICAL_CORE.md §4 for the same reasoning applied to
 * Task, and docs/EVENT_ARCHITECTURE.md for why a real event log is not
 * built yet). Every entry's `sourceType`/`sourceId` links back to the
 * authoritative row.
 */
export interface TimelineEntry {
  id: string;
  timestamp: string;
  type: string;
  summary: string;
  department?: string | null;
  actor?: string | null;
  sourceType: string;
  sourceId: string;
}

// Milestone E hardening: every source is capped (TIMELINE_ROW_LIMIT, its most
// recent rows by its own time) for the callers that read the whole feed.
// Flagship 2d: the feed is built from STREAMS, one per kind of entry, each a
// query ordered by that entry's own timestamp (a lab result's "entered",
// "verified" and "amended" are three streams), so a page can be cut exactly
// with a cursor: every stream is asked for its newest rows older than the
// cursor, and the merge of those is the next page. No entry is skipped or
// repeated between pages, whatever the gaps between a row's own timestamps.
const TIMELINE_ROW_LIMIT = 200;
export const TIMELINE_PAGE_SIZE = 50;

/** A bound on a stream's timestamp: older than, at most, or exactly; null for none. */
type Range = { lt: Date } | { lte: Date } | { equals: Date } | null;
interface Stream { prefix: string; fetch(range: Range, take: number | undefined): Promise<TimelineEntry[]> }

const bound = (r: Range) => r ?? {};
const notNull = (r: Range) => ({ not: null, ...bound(r) });
const STAFF_NAME = { select: { user: { select: { displayName: true } } } } as const;

function streamsFor(patientIds: string[], documentsVisible: Awaited<ReturnType<typeof documentVisibilityFor>>): Stream[] {
  const P = { in: patientIds };
  const desc = <F extends string>(field: F) => [{ [field]: "desc" }, { id: "asc" }] as { [K in F]: "desc" }[] & { id: "asc" }[];
  return [
    { prefix: "encounter", fetch: async (r, take) => (await prisma.encounter.findMany({ where: { patientId: P, registeredAt: bound(r) }, include: { department: { select: { name: true } } }, orderBy: desc("registeredAt"), take }))
      .map((e) => ({ id: `encounter-${e.id}`, timestamp: e.registeredAt.toISOString(), type: "Encounter", summary: `${e.type} encounter registered${e.chiefComplaint ? ` — ${e.chiefComplaint}` : ""}`, department: e.department?.name, sourceType: "Encounter", sourceId: e.id })) },
    { prefix: "encounter-closed", fetch: async (r, take) => (await prisma.encounter.findMany({ where: { patientId: P, closedAt: notNull(r) }, include: { department: { select: { name: true } } }, orderBy: desc("closedAt"), take }))
      .map((e) => ({ id: `encounter-closed-${e.id}`, timestamp: e.closedAt!.toISOString(), type: "Encounter", summary: `${e.type} encounter ${e.status === "CANCELLED" ? "cancelled" : "closed"}`, department: e.department?.name, sourceType: "Encounter", sourceId: e.id })) },
    { prefix: "diagnosis", fetch: async (r, take) => (await prisma.diagnosis.findMany({ where: { patientId: P, createdAt: bound(r) }, include: { diagnosedBy: STAFF_NAME }, orderBy: desc("createdAt"), take }))
      .map((d) => ({ id: `diagnosis-${d.id}`, timestamp: d.createdAt.toISOString(), type: "Diagnosis", summary: `${d.type}: ${d.diagnosis}`, actor: d.diagnosedBy?.user?.displayName, sourceType: "Diagnosis", sourceId: d.id })) },
    { prefix: "problem", fetch: async (r, take) => (await prisma.problem.findMany({ where: { patientId: P, createdAt: bound(r) }, orderBy: desc("createdAt"), take }))
      .map((p) => ({ id: `problem-${p.id}`, timestamp: p.createdAt.toISOString(), type: "Problem", summary: `Problem list: ${p.diagnosis} (${p.status})`, sourceType: "Problem", sourceId: p.id })) },
    { prefix: "allergy", fetch: async (r, take) => (await prisma.allergy.findMany({ where: { patientId: P, recordedAt: bound(r) }, orderBy: desc("recordedAt"), take }))
      .map((a) => ({
        id: `allergy-${a.id}`, timestamp: a.recordedAt.toISOString(), type: "Allergy",
        summary: a.source === "PATIENT_PROVIDED"
          ? `Allergy reported by the patient (${a.verification === "CONFIRMED" ? "confirmed" : "unconfirmed"}): ${a.substance}${a.severity ? ` (${a.severity})` : ""}`
          : `Allergy recorded: ${a.substance} (${a.severity})`,
        sourceType: "Allergy", sourceId: a.id,
      })) },
    { prefix: "vital", fetch: async (r, take) => (await prisma.vital.findMany({ where: { encounter: { patientId: P }, recordedAt: bound(r) }, orderBy: desc("recordedAt"), take }))
      .map((v) => ({ id: `vital-${v.id}`, timestamp: v.recordedAt.toISOString(), type: "Vital", summary: `Vitals: HR ${v.hr ?? "-"}, BP ${v.sbp ?? "-"}/${v.dbp ?? "-"}, SpO2 ${v.spo2 ?? "-"}%`, sourceType: "Vital", sourceId: v.id })) },
    { prefix: "note", fetch: async (r, take) => (await prisma.clinicalNote.findMany({ where: { encounter: { patientId: P }, createdAt: bound(r) }, select: { id: true, type: true, status: true, createdAt: true, author: STAFF_NAME }, orderBy: desc("createdAt"), take }))
      .map((n) => ({ id: `note-${n.id}`, timestamp: n.createdAt.toISOString(), type: "Note", summary: `${n.type} note ${n.status === "SIGNED" ? "signed" : n.status.toLowerCase()}`, actor: n.author?.user?.displayName, sourceType: "ClinicalNote", sourceId: n.id })) },
    { prefix: "medorder", fetch: async (r, take) => (await prisma.medicationOrder.findMany({ where: { patientId: P, orderedAt: bound(r) }, orderBy: desc("orderedAt"), take }))
      .map((m) => ({ id: `medorder-${m.id}`, timestamp: m.orderedAt.toISOString(), type: "Medication", summary: `Medication ordered: ${m.drugName} ${m.dose} ${m.route} ${m.frequency}`, sourceType: "MedicationOrder", sourceId: m.id })) },
    { prefix: "lab", fetch: async (r, take) => (await prisma.labOrder.findMany({ where: { patientId: P, orderedAt: bound(r) }, include: { results: { where: { isCurrent: true } } }, orderBy: desc("orderedAt"), take }))
      .map((l) => { const current = l.results[0]; return { id: `lab-${l.id}`, timestamp: l.orderedAt.toISOString(), type: "Order", summary: `Lab ordered: ${l.testName}${current ? ` — result: ${current.value} ${current.unit ?? ""}` : ""}`, sourceType: "LabOrder", sourceId: l.id }; }) },
    { prefix: "specimen-collected", fetch: async (r, take) => (await prisma.specimen.findMany({ where: { patientId: P, collectedAt: notNull(r) }, orderBy: desc("collectedAt"), take }))
      .map((s) => ({ id: `specimen-collected-${s.id}`, timestamp: s.collectedAt!.toISOString(), type: "Specimen", summary: `Specimen collected — ${s.specimenType} (${s.accessionNumber})`, sourceType: "Specimen", sourceId: s.id })) },
    { prefix: "specimen-accepted", fetch: async (r, take) => (await prisma.specimen.findMany({ where: { patientId: P, acceptedAt: notNull(r) }, orderBy: desc("acceptedAt"), take }))
      .map((s) => ({ id: `specimen-accepted-${s.id}`, timestamp: s.acceptedAt!.toISOString(), type: "Specimen", summary: `Specimen accepted — ${s.accessionNumber}`, sourceType: "Specimen", sourceId: s.id })) },
    { prefix: "specimen-rejected", fetch: async (r, take) => (await prisma.specimen.findMany({ where: { patientId: P, rejectedAt: notNull(r) }, orderBy: desc("rejectedAt"), take }))
      .map((s) => ({ id: `specimen-rejected-${s.id}`, timestamp: s.rejectedAt!.toISOString(), type: "Specimen", summary: `Specimen rejected — ${s.accessionNumber} (${s.rejectedReason ?? "unspecified"})`, sourceType: "Specimen", sourceId: s.id })) },
    { prefix: "specimen-recollected", fetch: async (r, take) => (await prisma.specimen.findMany({ where: { patientId: P, recollectionOfSpecimenId: { not: null }, createdAt: bound(r) }, orderBy: desc("createdAt"), take }))
      .map((s) => ({ id: `specimen-recollected-${s.id}`, timestamp: s.createdAt.toISOString(), type: "Specimen", summary: `Specimen recollected — ${s.accessionNumber}`, sourceType: "Specimen", sourceId: s.id })) },
    { prefix: "result-entered", fetch: async (r, take) => (await prisma.labResult.findMany({ where: { labOrder: { patientId: P }, resultedAt: bound(r) }, orderBy: desc("resultedAt"), take }))
      .map((x) => ({ id: `result-entered-${x.id}`, timestamp: x.resultedAt.toISOString(), type: "Result", summary: `Lab result entered${x.isCritical ? " — CRITICAL" : ""}: ${x.value} ${x.unit ?? ""}`, sourceType: "LabResult", sourceId: x.id })) },
    { prefix: "result-verified", fetch: async (r, take) => (await prisma.labResult.findMany({ where: { labOrder: { patientId: P }, verifiedAt: notNull(r) }, orderBy: desc("verifiedAt"), take }))
      .map((x) => ({ id: `result-verified-${x.id}`, timestamp: x.verifiedAt!.toISOString(), type: "Result", summary: "Lab result verified", sourceType: "LabResult", sourceId: x.id })) },
    { prefix: "result-amended", fetch: async (r, take) => (await prisma.labResult.findMany({ where: { labOrder: { patientId: P }, amendedAt: notNull(r) }, orderBy: desc("amendedAt"), take }))
      .map((x) => ({ id: `result-amended-${x.id}`, timestamp: x.amendedAt!.toISOString(), type: "Result", summary: `Lab result amended: ${x.amendedReason ?? ""}`, sourceType: "LabResult", sourceId: x.id })) },
    { prefix: "imaging", fetch: async (r, take) => (await prisma.imagingOrder.findMany({ where: { patientId: P, orderedAt: bound(r) }, include: { reports: { where: { isCurrent: true } } }, orderBy: desc("orderedAt"), take }))
      .map((im) => { const currentReport = im.reports[0]; return { id: `imaging-${im.id}`, timestamp: im.orderedAt.toISOString(), type: "Order", summary: `${im.modality} ordered: ${im.studyDescription}${currentReport ? ` — ${currentReport.impression}` : ""}`, sourceType: "ImagingOrder", sourceId: im.id }; }) },
    { prefix: "study-scheduled", fetch: async (r, take) => (await prisma.imagingStudy.findMany({ where: { patientId: P, scheduledAt: bound(r) }, orderBy: desc("scheduledAt"), take }))
      .map((s) => ({ id: `study-scheduled-${s.id}`, timestamp: s.scheduledAt.toISOString(), type: "Study", summary: `${s.modality} study scheduled — ${s.accessionNumber}`, sourceType: "ImagingStudy", sourceId: s.id })) },
    { prefix: "study-arrived", fetch: async (r, take) => (await prisma.imagingStudy.findMany({ where: { patientId: P, arrivedAt: notNull(r) }, orderBy: desc("arrivedAt"), take }))
      .map((s) => ({ id: `study-arrived-${s.id}`, timestamp: s.arrivedAt!.toISOString(), type: "Study", summary: `Patient arrived for ${s.modality} study`, sourceType: "ImagingStudy", sourceId: s.id })) },
    { prefix: "study-started", fetch: async (r, take) => (await prisma.imagingStudy.findMany({ where: { patientId: P, startedAt: notNull(r) }, orderBy: desc("startedAt"), take }))
      .map((s) => ({ id: `study-started-${s.id}`, timestamp: s.startedAt!.toISOString(), type: "Study", summary: `${s.modality} study started`, sourceType: "ImagingStudy", sourceId: s.id })) },
    { prefix: "study-completed", fetch: async (r, take) => (await prisma.imagingStudy.findMany({ where: { patientId: P, performedAt: notNull(r) }, orderBy: desc("performedAt"), take }))
      .map((s) => ({ id: `study-completed-${s.id}`, timestamp: s.performedAt!.toISOString(), type: "Study", summary: `${s.modality} study completed`, sourceType: "ImagingStudy", sourceId: s.id })) },
    { prefix: "imaging-report-entered", fetch: async (r, take) => (await prisma.imagingReport.findMany({ where: { imagingOrder: { patientId: P }, reportedAt: bound(r) }, orderBy: desc("reportedAt"), take }))
      .map((x) => ({ id: `imaging-report-entered-${x.id}`, timestamp: x.reportedAt.toISOString(), type: "Result", summary: `Imaging report entered${x.isCritical ? " — CRITICAL" : ""}: ${x.impression}`, sourceType: "ImagingReport", sourceId: x.id })) },
    { prefix: "imaging-report-verified", fetch: async (r, take) => (await prisma.imagingReport.findMany({ where: { imagingOrder: { patientId: P }, verifiedAt: notNull(r) }, orderBy: desc("verifiedAt"), take }))
      .map((x) => ({ id: `imaging-report-verified-${x.id}`, timestamp: x.verifiedAt!.toISOString(), type: "Result", summary: "Imaging report verified", sourceType: "ImagingReport", sourceId: x.id })) },
    { prefix: "imaging-report-acknowledged", fetch: async (r, take) => (await prisma.imagingReport.findMany({ where: { imagingOrder: { patientId: P }, acknowledgedAt: notNull(r) }, orderBy: desc("acknowledgedAt"), take }))
      .map((x) => ({ id: `imaging-report-acknowledged-${x.id}`, timestamp: x.acknowledgedAt!.toISOString(), type: "Result", summary: "Critical imaging finding acknowledged", sourceType: "ImagingReport", sourceId: x.id })) },
    { prefix: "imaging-report-amended", fetch: async (r, take) => (await prisma.imagingReport.findMany({ where: { imagingOrder: { patientId: P }, amendedAt: notNull(r) }, orderBy: desc("amendedAt"), take }))
      .map((x) => ({ id: `imaging-report-amended-${x.id}`, timestamp: x.amendedAt!.toISOString(), type: "Result", summary: `Imaging report amended: ${x.amendedReason ?? ""}`, sourceType: "ImagingReport", sourceId: x.id })) },
    { prefix: "task", fetch: async (r, take) => (await prisma.task.findMany({ where: { patientId: P, createdAt: bound(r) }, orderBy: desc("createdAt"), take }))
      .map((t) => ({ id: `task-${t.id}`, timestamp: t.createdAt.toISOString(), type: "Task", summary: `Task created: ${t.title} (${t.status})`, sourceType: "Task", sourceId: t.id })) },
    { prefix: "referral", fetch: async (r, take) => (await prisma.referral.findMany({ where: { patientId: P, createdAt: bound(r) }, orderBy: desc("createdAt"), take }))
      .map((x) => ({ id: `referral-${x.id}`, timestamp: x.createdAt.toISOString(), type: "Referral", summary: `Referral: ${x.reason} (${x.status})`, sourceType: "Referral", sourceId: x.id })) },
    { prefix: "admission", fetch: async (r, take) => (await prisma.admission.findMany({ where: { encounter: { patientId: P }, admittedAt: bound(r) }, include: { bed: { select: { label: true } } }, orderBy: desc("admittedAt"), take }))
      .map((a) => ({ id: `admission-${a.id}`, timestamp: a.admittedAt.toISOString(), type: "Admission", summary: `Admitted${a.admissionType ? ` (${a.admissionType})` : ""} — bed ${a.bed.label}: ${a.reason}`, sourceType: "Admission", sourceId: a.id })) },
    { prefix: "discharge", fetch: async (r, take) => (await prisma.discharge.findMany({ where: { admission: { encounter: { patientId: P } }, dischargedAt: notNull(r) }, orderBy: desc("dischargedAt"), take }))
      .map((d) => ({ id: `discharge-${d.id}`, timestamp: d.dischargedAt!.toISOString(), type: "Discharge", summary: `Discharged${d.dischargeType ? ` (${d.dischargeType})` : ""}`, sourceType: "Discharge", sourceId: d.id })) },
    { prefix: "transfer", fetch: async (r, take) => (await prisma.transfer.findMany({ where: { admission: { encounter: { patientId: P } }, toLocation: { assignedAt: bound(r) } }, include: TRANSFER_WITH_LOCATIONS, orderBy: [{ toLocation: { assignedAt: "desc" } }, { id: "asc" }], take }))
      .map((t) => ({ id: `transfer-${t.id}`, timestamp: t.toLocation.assignedAt.toISOString(), type: "Transfer", summary: `Transferred ${transferRouteLabel(t)}: ${t.reason}`, sourceType: "Transfer", sourceId: t.id })) },
    { prefix: "document", fetch: async (r, take) => (await prisma.clinicalDocument.findMany({ where: { AND: [{ patientId: P }, documentsVisible, { createdAt: bound(r) }] }, include: { uploadedBy: STAFF_NAME }, orderBy: desc("createdAt"), take }))
      .map((doc) => ({ id: `document-${doc.id}`, timestamp: doc.createdAt.toISOString(), type: "Document", summary: `${doc.type} document${doc.version > 1 ? ` (v${doc.version})` : ""}: ${doc.title}`, actor: doc.uploadedBy?.user?.displayName, sourceType: "ClinicalDocument", sourceId: doc.id })) },
  ];
}

/** The person-side entries (their uploads and confirmed facts), as the viewer may see them: few, so read whole. */
async function personEntries(viewer: DocumentViewer, patientIds: string[]): Promise<TimelineEntry[]> {
  const [personDocuments, provided] = await Promise.all([personDocumentsFor(viewer, patientIds), patientProvidedRecordsFor(viewer, patientIds)]);
  return [
    // Phase 0: the person's own uploads (patient-provided), as the viewer may see them.
    ...personDocuments.map((doc) => ({ id: `person-document-${doc.id}`, timestamp: doc.uploadedAt.toISOString(), type: "Document", summary: `Patient-provided ${doc.type} document: ${doc.title}`, actor: undefined, sourceType: "PersonDocument", sourceId: doc.id })),
    // Week 4a: confirmed patient-provided entries, under the same rule as the uploads they came from.
    ...provided.map((r) => ({ id: `patient-provided-${r.id}`, timestamp: (r.effectiveDate ?? r.createdAt).toISOString(), type: "Patient-provided", summary: describePatientProvided(r), actor: undefined, sourceType: "PatientProvidedRecord", sourceId: r.id })),
  ];
}

/** Newest first; at the same moment, by entry id (code-unit order, the same order the cursor compares in). */
const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
const byFeedOrder = (a: TimelineEntry, b: TimelineEntry) => cmp(b.timestamp, a.timestamp) || cmp(a.id, b.id);

export interface TimelineCursor { t: string; id: string }
export function encodeTimelineCursor(e: Pick<TimelineEntry, "timestamp" | "id">): string {
  return Buffer.from(JSON.stringify({ t: e.timestamp, id: e.id })).toString("base64url");
}
export function decodeTimelineCursor(raw: string | null | undefined): TimelineCursor | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as TimelineCursor;
    return typeof c.t === "string" && typeof c.id === "string" && !Number.isNaN(Date.parse(c.t)) ? c : null;
  } catch {
    return null;
  }
}
/** Is `e` after the cursor in feed order (older, or as old with a later id)? */
const afterCursor = (e: TimelineEntry, c: TimelineCursor) => e.timestamp < c.t || (e.timestamp === c.t && e.id > c.id);

/** `viewer` decides which patient uploads appear (Phase 0, personAccess): required, so no caller can skip it. */
export async function buildPatientTimeline(patientId: string, viewer: DocumentViewer): Promise<TimelineEntry[]> {
  const patientIds = await resolvePatientIdsForRead(patientId);
  const streams = streamsFor(patientIds, await documentVisibilityFor(viewer, patientIds));
  const parts = await Promise.all([...streams.map((s) => s.fetch(null, TIMELINE_ROW_LIMIT)), personEntries(viewer, patientIds)]);
  return parts.flat().sort(byFeedOrder);
}

/**
 * Flagship 2d — one page of the timeline, newest first: the `limit` entries
 * after `cursor` (from the start without one) and the cursor for the next
 * page, null at the end. Exact: each stream is asked only for rows past the
 * cursor in its own time order (ties at the cursor's moment read whole and
 * cut in memory, so the database's collation never decides an order).
 */
export async function timelinePage(patientId: string, viewer: DocumentViewer, opts: { cursor?: string | null; limit?: number } = {}): Promise<{ entries: TimelineEntry[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(1, opts.limit ?? TIMELINE_PAGE_SIZE), 200);
  const cursor = decodeTimelineCursor(opts.cursor);
  const patientIds = await resolvePatientIdsForRead(patientId);
  const streams = streamsFor(patientIds, await documentVisibilityFor(viewer, patientIds));
  const take = limit + 1;
  // A stream cut at `take` rows is completed with every row at its last
  // moment, so the cut never falls inside a run of equal timestamps (whose
  // order the database's collation, not the feed's, would have decided).
  const cut = async (s: Stream, range: Range): Promise<TimelineEntry[]> => {
    const rows = await s.fetch(range, take);
    if (rows.length < take) return rows;
    const last = new Date(rows[rows.length - 1].timestamp);
    const tied = await s.fetch({ equals: last }, undefined);
    const seen = new Set(rows.map((e) => e.id));
    return [...rows, ...tied.filter((e) => !seen.has(e.id))];
  };
  const parts = await Promise.all([
    ...streams.map(async (s) => {
      if (!cursor) return cut(s, null);
      const t = new Date(cursor.t);
      const head = `${s.prefix}-`;
      const pre = cursor.id.slice(0, head.length);
      const order = cmp(head, pre);
      // Entries at the cursor's moment come after it only if their id sorts after the cursor's.
      if (order > 0) return cut(s, { lte: t });
      if (order < 0) return cut(s, { lt: t });
      const [same, older] = await Promise.all([s.fetch({ equals: t }, undefined), cut(s, { lt: t })]);
      return [...same, ...older];
    }),
    personEntries(viewer, patientIds),
  ]);
  const candidates = parts.flat().filter((e) => !cursor || afterCursor(e, cursor)).sort(byFeedOrder);
  const entries = candidates.slice(0, limit);
  return { entries, nextCursor: candidates.length > limit ? encodeTimelineCursor(entries[entries.length - 1]) : null };
}

/** Flagship 2d — the small header above the first page: how much there is, and over what span. */
export async function timelineSummary(patientId: string, viewer: DocumentViewer) {
  const patientIds = await resolvePatientIdsForRead(patientId);
  const P = { in: patientIds };
  const [encounters, admissions, labOrders, imagingOrders, medicationOrders, notes, first, last] = await Promise.all([
    prisma.encounter.count({ where: { patientId: P } }),
    prisma.admission.count({ where: { encounter: { patientId: P } } }),
    prisma.labOrder.count({ where: { patientId: P } }),
    prisma.imagingOrder.count({ where: { patientId: P } }),
    prisma.medicationOrder.count({ where: { patientId: P } }),
    prisma.clinicalNote.count({ where: { encounter: { patientId: P } } }),
    prisma.encounter.findFirst({ where: { patientId: P }, orderBy: { registeredAt: "asc" }, select: { registeredAt: true } }),
    prisma.encounter.findFirst({ where: { patientId: P }, orderBy: { registeredAt: "desc" }, select: { registeredAt: true } }),
  ]);
  const person = await personEntries(viewer, patientIds);
  return {
    counts: { encounters, admissions, labOrders, imagingOrders, medicationOrders, notes, patientProvided: person.length },
    firstVisitAt: first?.registeredAt.toISOString() ?? null,
    lastVisitAt: last?.registeredAt.toISOString() ?? null,
  };
}
