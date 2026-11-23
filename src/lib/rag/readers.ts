import { Prisma, type RagCategory, type RagSensitiveCategory } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { AiAccess } from "./access";
import type { LiveFact } from "./retrieve";
import { isoDay, renderSource } from "./render";
import { ANALYTE_TEST_NAMES, type ReaderId, type RetrievalPlan, type VitalKind } from "./router";
import { ALL_SENSITIVE, type ScopeSegment } from "./scope";
import { SENSITIVE_CODE_PATTERNS, SENSITIVE_WORD_PATTERNS } from "./sensitivity";

/**
 * RAG Phase 3, step 3.3 — structured readers (docs/RAG_ARCHITECTURE.md §6.1):
 * the answer to "latest haemoglobin" read from the authoritative tables, not
 * from the index. Each reader:
 *   - takes the resolved access object, never ids from the request: a
 *     patient-record segment of the scope (TREATING, NURSE_ASSIGNED, SHARE,
 *     ORG_CONSENT) whose categories include the reader's;
 *   - applies every access condition inside its SQL: the segment's patients
 *     and facilities, its period, the released status, and the sensitive
 *     categories it has not opted in (excluded if any rule matches);
 *   - is bounded (LIMIT), ordered, and explicit about its dates;
 *   - says "not recorded" by returning nothing, never "none".
 * Staff modes only: a patient's own modes are about one report or the whole
 * record, and never route to a reader. The current encounter is for the
 * treating team (TREATING, NURSE_ASSIGNED) only.
 *
 * Imported results (step 3.6, §13 decision 6) are read for the treating team
 * only, always labelled "imported", never the latest value when a verified
 * one exists, and a disagreement with the latest verified value is stated.
 *
 * A fact reads like the indexed passage for the same row (the same
 * renderer), with a stable id "live:<kind>:<id>", so the generator, the
 * validator and the citations need no change.
 */
export type ReaderFact = Omit<LiveFact, "sourceType"> & { sourceType: string; reader: ReaderId };

const READER_CATEGORY: Record<ReaderId, RagCategory | null> = {
  VITALS: "VITALS", LAB_LATEST: "LABS", LAB_TREND: "LABS", ORDERS_PENDING: "LABS", ENCOUNTER_CURRENT: null, PROBLEMS: "DIAGNOSES", ALLERGIES: "ALLERGIES", MEDICINES: "PRESCRIPTIONS",
};
const TREATING = new Set(["TREATING", "NURSE_ASSIGNED"]);
const TREND_TAKE = 20;

/** The patient-record segments of a staff scope that admit this category (verified rows). */
export function readerSegments(access: AiAccess, category: RagCategory | null): ScopeSegment[] {
  if (access.audience !== "STAFF") return [];
  return access.scope.segments.filter((s) => s.facility && s.facility.patientIds.length && s.facility.facilityIds.length && s.origins.includes("VERIFIED")
    && (category ? s.categories.includes(category) : TREATING.has(s.path)));
}

/** NOT any sensitive rule the segment hasn't opted in, on these text columns (and an ICD code column). */
export function notSensitiveSql(allowed: readonly RagSensitiveCategory[], texts: Prisma.Sql[], code?: Prisma.Sql): Prisma.Sql {
  const blocked = ALL_SENSITIVE.filter((c) => !allowed.includes(c));
  if (!blocked.length) return Prisma.sql`true`;
  const text = Prisma.sql`concat_ws(' ', ${Prisma.join(texts.map((t) => Prisma.sql`coalesce(${t}, '')`), ", ")})`;
  const parts: Prisma.Sql[] = SENSITIVE_WORD_PATTERNS.filter((p) => blocked.includes(p.category)).map((p) => Prisma.sql`${text} ~* ${p.pattern}`);
  if (code) parts.push(...SENSITIVE_CODE_PATTERNS.filter((p) => blocked.includes(p.category)).map((p) => Prisma.sql`upper(coalesce(${code}, '')) ~ ${p.pattern}`));
  return parts.length ? Prisma.sql`NOT (${Prisma.join(parts, " OR ")})` : Prisma.sql`true`;
}

const periodSql = (col: Prisma.Sql, s: ScopeSegment, plan?: RetrievalPlan): Prisma.Sql => {
  const parts: Prisma.Sql[] = [];
  // The segment's period (a share's) and the question's, both: the narrower wins.
  for (const from of [s.recordedFrom, plan?.entities.period?.from]) if (from) parts.push(Prisma.sql`${col} >= ${from}`);
  for (const to of [s.recordedTo, plan?.entities.period?.to]) if (to) parts.push(Prisma.sql`${col} <= ${to}`);
  return parts.length ? Prisma.join(parts, " AND ") : Prisma.sql`true`;
};

/** An analyte as one case-insensitive whole-word pattern over a test name; haemoglobin never matches glycated haemoglobin. */
export function analytePattern(analyte: string): { match: string; exclude: string | null } | null {
  const names = ANALYTE_TEST_NAMES[analyte];
  if (!names) return null;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { match: `\\y(${names.map(esc).join("|")})\\y`, exclude: analyte === "Hemoglobin" ? "glycated|glycosylated|a1c" : null };
}

// ── labs (verified, and imported for the treating team) ─────────────────────

async function labs(access: AiAccess, plan: RetrievalPlan, reader: "LAB_LATEST" | "LAB_TREND"): Promise<ReaderFact[]> {
  const p = plan.entities.analyte ? analytePattern(plan.entities.analyte) : null;
  if (!p) return [];
  const take = reader === "LAB_LATEST" ? 1 : TREND_TAKE;
  const out: ReaderFact[] = [];
  for (const s of readerSegments(access, "LABS")) {
    const name = Prisma.sql`coalesce(ct."name", o."testName")`;
    const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT r."id" FROM "LabResult" r JOIN "LabOrder" o ON o."id" = r."labOrderId" JOIN "Encounter" e ON e."id" = o."encounterId"
        LEFT JOIN "LabTestCatalog" ct ON ct."id" = r."catalogTestId"
      WHERE o."patientId" = ANY(${s.facility!.patientIds}::text[]) AND e."facilityId" = ANY(${s.facility!.facilityIds}::text[])
        AND r."isCurrent" AND r."status" IN ('VERIFIED', 'AMENDED')
        AND ${name} ~* ${p.match} ${p.exclude ? Prisma.sql`AND NOT (${name} ~* ${p.exclude})` : Prisma.empty}
        AND ${periodSql(Prisma.sql`r."resultedAt"`, s, plan)} AND ${notSensitiveSql(s.sensitive, [name])}
      ORDER BY r."resultedAt" DESC, r."id" LIMIT ${take}`);
    if (!rows.length) continue;
    const results = await prisma.labResult.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, value: true, unit: true, referenceRange: true, abnormalFlag: true, isCritical: true, resultedAt: true, status: true, labOrder: { select: { testName: true } }, catalogTest: { select: { name: true } } } });
    for (const r of results.sort((a, b) => b.resultedAt.getTime() - a.resultedAt.getTime() || a.id.localeCompare(b.id))) {
      const rd = renderSource({ sourceType: "LAB_RESULT", testName: r.catalogTest?.name ?? r.labOrder.testName, value: r.value, unit: r.unit, referenceRange: r.referenceRange, flag: r.abnormalFlag, critical: r.isCritical, at: r.resultedAt, amended: r.status === "AMENDED" });
      out.push({ chunkId: `live:lab:${r.id}`, context: rd.context, text: rd.sections.map((x) => x.text).join("\n"), origin: "VERIFIED", sourceType: "LAB_RESULT", sourceId: r.id, recordedAt: r.resultedAt, reader });
    }
  }
  // Step 3.6: imported values, for the treating team, after the verified ones.
  const imported: ReaderFact[] = [];
  for (const s of readerSegments(access, "LABS").filter((x) => TREATING.has(x.path) && x.origins.includes("IMPORTED"))) {
    const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT l."id" FROM "LegacyLabResult" l
      WHERE l."patientId" = ANY(${s.facility!.patientIds}::text[]) AND l."facilityId" = ANY(${s.facility!.facilityIds}::text[])
        AND l."testName" ~* ${p.match} ${p.exclude ? Prisma.sql`AND NOT (l."testName" ~* ${p.exclude})` : Prisma.empty}
        AND ${periodSql(Prisma.sql`l."observedAt"`, s, plan)} AND ${notSensitiveSql(s.sensitive, [Prisma.sql`l."testName"`])}
      ORDER BY l."observedAt" DESC, l."id" LIMIT ${take}`);
    if (!rows.length) continue;
    const rs = await prisma.legacyLabResult.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
    for (const l of rs.sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime() || a.id.localeCompare(b.id))) {
      const rd = renderSource({ sourceType: "LEGACY_LAB_RESULT", testName: l.testName, value: l.value, unit: l.unit, referenceRange: l.referenceRange, flag: l.abnormalFlag, sourceSystem: l.sourceSystem, at: l.observedAt });
      imported.push({ chunkId: `live:labimp:${l.id}`, context: rd.context, text: rd.sections.map((x) => x.text).join("\n"), origin: "IMPORTED", sourceType: "LEGACY_LAB_RESULT", sourceId: l.id, recordedAt: l.observedAt, reader });
    }
  }
  if (!imported.length) return out;
  const verified = out[0];
  if (!verified) return imported;
  // Never the latest when a verified value exists: verified first, imported after, and a disagreement said.
  const newestImported = imported[0];
  const value = (t: string) => t.match(/\s(-?\d+(?:\.\d+)?)\s/)?.[1];
  const v1 = value(verified.text), v2 = value(newestImported.text);
  const facts = [...out, ...imported];
  if (v1 && v2 && v1 !== v2) {
    facts.splice(out.length, 0, {
      chunkId: `live:labdiff:${newestImported.sourceId}`, context: `[Imported against verified · ${plan.entities.analyte} · ${isoDay(newestImported.recordedAt)} · imported]`,
      text: `The imported ${plan.entities.analyte} value ${v2} (observed ${isoDay(newestImported.recordedAt)}, not verified in this hospital) differs from the latest verified value ${v1} (resulted ${isoDay(verified.recordedAt)}); the verified value is the latest.`,
      origin: "IMPORTED", sourceType: "LEGACY_LAB_RESULT", sourceId: newestImported.sourceId, recordedAt: newestImported.recordedAt, reader,
    });
  }
  return facts;
}

// ── vitals ──────────────────────────────────────────────────────────────────

// The NEWS2 score is not read: it awaits clinical sign-off and nothing may act on it yet (the offline gate checks).
const VITAL_COLUMN: Record<VitalKind, string> = { BP: "sbp", HR: "hr", SPO2: "spo2", TEMP: "tempC", RR: "rr", PAIN: "painScore" };

async function vitals(access: AiAccess, plan: RetrievalPlan): Promise<ReaderFact[]> {
  const out: ReaderFact[] = [];
  const kinds = plan.entities.vitals ?? [];
  const take = plan.entities.trend ? 10 : 1;
  // A row that has at least one of the asked-for measurements (or any, for "vitals").
  const some = kinds.length ? Prisma.join(kinds.map((k) => Prisma.sql`v.${Prisma.raw(`"${VITAL_COLUMN[k]}"`)} IS NOT NULL`), " OR ") : Prisma.sql`true`;
  for (const s of readerSegments(access, "VITALS")) {
    const rows = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT v."id" FROM "Vital" v JOIN "Encounter" e ON e."id" = v."encounterId"
      WHERE e."patientId" = ANY(${s.facility!.patientIds}::text[]) AND e."facilityId" = ANY(${s.facility!.facilityIds}::text[])
        AND (${some}) AND ${periodSql(Prisma.sql`v."recordedAt"`, s, plan)}
      ORDER BY v."recordedAt" DESC, v."id" LIMIT ${take}`);
    if (!rows.length) continue;
    const vs = await prisma.vital.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: [{ recordedAt: "desc" }, { id: "asc" }], select: { id: true, encounterId: true, recordedAt: true, hr: true, sbp: true, dbp: true, rr: true, spo2: true, tempC: true, painScore: true } });
    for (const v of vs) {
      const rd = renderSource({ sourceType: "OBSERVATION", day: v.recordedAt, rows: [{ at: v.recordedAt, hr: v.hr, sbp: v.sbp, dbp: v.dbp, rr: v.rr, spo2: v.spo2, tempC: v.tempC, painScore: v.painScore }] });
      out.push({ chunkId: `live:vitals:${v.id}`, context: rd.context, text: rd.sections[0].text, origin: "VERIFIED", sourceType: "OBSERVATION", sourceId: `${v.encounterId}:${isoDay(v.recordedAt)}`, recordedAt: v.recordedAt, reader: "VITALS" });
    }
  }
  return out;
}

// ── pending orders ──────────────────────────────────────────────────────────

async function pendingOrders(access: AiAccess, plan: RetrievalPlan): Promise<ReaderFact[]> {
  const out: ReaderFact[] = [];
  const p = plan.entities.analyte ? analytePattern(plan.entities.analyte) : null;
  for (const s of readerSegments(access, "LABS")) {
    const rows = await prisma.$queryRaw<{ id: string; testName: string; priority: string; status: string; orderedAt: Date }[]>(Prisma.sql`
      SELECT o."id", coalesce(ct."name", o."testName") AS "testName", o."priority"::text, o."status"::text, o."orderedAt" FROM "LabOrder" o
        JOIN "Encounter" e ON e."id" = o."encounterId" LEFT JOIN "LabTestCatalog" ct ON ct."id" = o."catalogTestId"
      WHERE o."patientId" = ANY(${s.facility!.patientIds}::text[]) AND e."facilityId" = ANY(${s.facility!.facilityIds}::text[])
        AND o."status" IN ('ORDERED', 'COLLECTED', 'IN_PROGRESS')
        AND NOT EXISTS (SELECT 1 FROM "LabResult" r WHERE r."labOrderId" = o."id" AND r."isCurrent" AND r."status" IN ('VERIFIED', 'AMENDED'))
        ${p ? Prisma.sql`AND coalesce(ct."name", o."testName") ~* ${p.match}` : Prisma.empty}
        AND ${periodSql(Prisma.sql`o."orderedAt"`, s, plan)} AND ${notSensitiveSql(s.sensitive, [Prisma.sql`coalesce(ct."name", o."testName")`])}
      ORDER BY o."orderedAt" DESC, o."id" LIMIT 20`);
    for (const o of rows) {
      out.push({ chunkId: `live:laborder:${o.id}`, context: `[Pending lab order · ${o.testName} · ${isoDay(o.orderedAt)} · verified]`, text: `Pending lab order: ${o.testName}, ${o.priority.toLowerCase()}, ${o.status.toLowerCase().replace(/_/g, " ")}; ordered ${isoDay(o.orderedAt)}; no released result yet.`, origin: "VERIFIED", sourceType: "LAB_ORDER", sourceId: o.id, recordedAt: o.orderedAt, reader: "ORDERS_PENDING" });
    }
  }
  if (p) return out;
  for (const s of readerSegments(access, "IMAGING")) {
    const rows = await prisma.$queryRaw<{ id: string; modality: string; studyDescription: string; priority: string; status: string; orderedAt: Date }[]>(Prisma.sql`
      SELECT o."id", o."modality", o."studyDescription", o."priority"::text, o."status"::text, o."orderedAt" FROM "ImagingOrder" o JOIN "Encounter" e ON e."id" = o."encounterId"
      WHERE o."patientId" = ANY(${s.facility!.patientIds}::text[]) AND e."facilityId" = ANY(${s.facility!.facilityIds}::text[])
        AND o."status" IN ('ORDERED', 'SCHEDULED', 'ACQUIRED')
        AND NOT EXISTS (SELECT 1 FROM "ImagingReport" r WHERE r."imagingOrderId" = o."id" AND r."isCurrent" AND r."status" IN ('VERIFIED', 'AMENDED'))
        AND ${periodSql(Prisma.sql`o."orderedAt"`, s, plan)} AND ${notSensitiveSql(s.sensitive, [Prisma.sql`o."studyDescription"`])}
      ORDER BY o."orderedAt" DESC, o."id" LIMIT 20`);
    for (const o of rows) {
      out.push({ chunkId: `live:imgorder:${o.id}`, context: `[Pending imaging order · ${o.studyDescription} · ${isoDay(o.orderedAt)} · verified]`, text: `Pending imaging order: ${o.studyDescription} (${o.modality}), ${o.priority.toLowerCase()}, ${o.status.toLowerCase()}; ordered ${isoDay(o.orderedAt)}; no released report yet.`, origin: "VERIFIED", sourceType: "IMAGING_ORDER", sourceId: o.id, recordedAt: o.orderedAt, reader: "ORDERS_PENDING" });
    }
  }
  return out;
}

// ── the current encounter (treating team only) ─────────────────────────────

async function currentEncounter(access: AiAccess): Promise<ReaderFact[]> {
  const out: ReaderFact[] = [];
  for (const s of readerSegments(access, null)) {
    const rows = await prisma.$queryRaw<{ id: string; type: string; status: string; registeredAt: Date; chiefComplaint: string | null; admittedAt: Date | null; reason: string | null; bed: string | null; ward: string | null }[]>(Prisma.sql`
      SELECT e."id", e."type"::text, e."status"::text, e."registeredAt", e."chiefComplaint", a."admittedAt", a."reason", b."label" AS "bed", w."name" AS "ward"
      FROM "Encounter" e LEFT JOIN "Admission" a ON a."encounterId" = e."id" LEFT JOIN "Bed" b ON b."id" = a."bedId" LEFT JOIN "Ward" w ON w."id" = b."wardId"
      WHERE e."patientId" = ANY(${s.facility!.patientIds}::text[]) AND e."facilityId" = ANY(${s.facility!.facilityIds}::text[])
        AND e."status" IN ('REGISTERED', 'TRIAGED', 'IN_CONSULTATION', 'INVESTIGATING', 'ADMITTED')
        AND ${notSensitiveSql(s.sensitive, [Prisma.sql`e."chiefComplaint"`, Prisma.sql`a."reason"`])}
      ORDER BY e."registeredAt" DESC, e."id" LIMIT 3`);
    for (const e of rows) {
      const where = e.bed ? `; bed ${e.bed}${e.ward ? `, ${e.ward}` : ""}` : "";
      const why = e.reason ?? e.chiefComplaint;
      out.push({ chunkId: `live:encounter:${e.id}`, context: `[Current encounter · ${e.type} · ${isoDay(e.registeredAt)} · verified]`, text: `Current encounter: ${e.type}, ${e.status.toLowerCase().replace(/_/g, " ")}${e.admittedAt ? `, admitted ${isoDay(e.admittedAt)}` : `, registered ${isoDay(e.registeredAt)}`}${where}${why ? `; reason: ${why}` : ""}.`, origin: "VERIFIED", sourceType: "ENCOUNTER", sourceId: e.id, recordedAt: e.admittedAt ?? e.registeredAt, reader: "ENCOUNTER_CURRENT" });
    }
  }
  return out;
}

// ── problems and diagnoses ─────────────────────────────────────────────────

async function problems(access: AiAccess, plan: RetrievalPlan): Promise<ReaderFact[]> {
  const out: ReaderFact[] = [];
  for (const s of readerSegments(access, "DIAGNOSES")) {
    const dx = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT d."id" FROM "Diagnosis" d JOIN "Encounter" e ON e."id" = d."encounterId"
      WHERE d."patientId" = ANY(${s.facility!.patientIds}::text[]) AND e."facilityId" = ANY(${s.facility!.facilityIds}::text[])
        AND d."status" IN ('ACTIVE', 'RESOLVED') AND ${periodSql(Prisma.sql`d."createdAt"`, s, plan)}
        AND ${notSensitiveSql(s.sensitive, [Prisma.sql`d."diagnosis"`, Prisma.sql`d."codeDisplay"`], Prisma.sql`d."code"`)}
      ORDER BY (d."status" = 'ACTIVE') DESC, d."createdAt" DESC, d."id" LIMIT 20`);
    const rows = await prisma.diagnosis.findMany({ where: { id: { in: dx.map((r) => r.id) } } });
    const order = new Map(dx.map((r, i) => [r.id, i]));
    for (const d of rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!)) {
      const rd = renderSource({ sourceType: "DIAGNOSIS", diagnosis: d.diagnosis, code: d.code, codeDisplay: d.codeDisplay, type: d.type, status: d.status, onsetDate: d.onsetDate, at: d.createdAt });
      out.push({ chunkId: `live:dx:${d.id}`, context: rd.context, text: rd.sections[0].text, origin: "VERIFIED", sourceType: "DIAGNOSIS", sourceId: d.id, recordedAt: d.createdAt, reader: "PROBLEMS" });
    }
    // The problem list has no facility of its own: the patient's facility is the segment's.
    const pr = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT p."id" FROM "Problem" p JOIN "Patient" pt ON pt."id" = p."patientId"
      WHERE p."patientId" = ANY(${s.facility!.patientIds}::text[]) AND pt."facilityId" = ANY(${s.facility!.facilityIds}::text[])
        AND p."status" IN ('ACTIVE', 'RECURRENCE', 'RELAPSE') AND ${periodSql(Prisma.sql`p."createdAt"`, s, plan)}
        AND ${notSensitiveSql(s.sensitive, [Prisma.sql`p."diagnosis"`, Prisma.sql`p."codeDisplay"`], Prisma.sql`p."code"`)}
      ORDER BY p."createdAt" DESC, p."id" LIMIT 20`);
    const prows = await prisma.problem.findMany({ where: { id: { in: pr.map((r) => r.id) } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }] });
    for (const p of prows) {
      const rd = renderSource({ sourceType: "PROBLEM", diagnosis: p.diagnosis, code: p.code, codeDisplay: p.codeDisplay, status: p.status, severity: p.severity, onsetDate: p.onsetDate, at: p.createdAt });
      out.push({ chunkId: `live:problem:${p.id}`, context: rd.context, text: rd.sections[0].text, origin: "VERIFIED", sourceType: "PROBLEM", sourceId: p.id, recordedAt: p.createdAt, reader: "PROBLEMS" });
    }
  }
  return out;
}

/**
 * The facts the plan's readers return, structured facts in reader order.
 * Allergies and medicines are the live facts retrieval already reads
 * (retrieve.ts); they are not read twice here.
 */
export async function runReaders(access: AiAccess, plan: RetrievalPlan): Promise<ReaderFact[]> {
  const out: ReaderFact[] = [];
  const seen = new Set<string>();
  for (const r of plan.readers) {
    if (READER_CATEGORY[r] === "ALLERGIES" || READER_CATEGORY[r] === "PRESCRIPTIONS") continue;
    const facts = r === "LAB_LATEST" || r === "LAB_TREND" ? await labs(access, plan, r)
      : r === "VITALS" ? await vitals(access, plan)
      : r === "ORDERS_PENDING" ? await pendingOrders(access, plan)
      : r === "ENCOUNTER_CURRENT" ? await currentEncounter(access)
      : await problems(access, plan);
    for (const f of facts) if (!seen.has(f.chunkId)) { seen.add(f.chunkId); out.push(f); }
  }
  return out;
}
