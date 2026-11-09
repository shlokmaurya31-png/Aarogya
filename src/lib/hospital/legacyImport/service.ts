import { createHash, randomBytes } from "node:crypto";
import type { EncounterType, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { facilityOrganizationId } from "@/lib/events/tenant";
import { facilityTimeZone, zonedInstant } from "@/lib/time/zone";
import { CsvFormatError, parseCsv } from "./csv";

type Tx = Prisma.TransactionClient;

/**
 * Flagship 2, step 6 — legacy import, phase 1 (docs/LEGACY_IMPORT_DESIGN.md
 * §10 decisions, §11 as built): a hospital's old patients and encounters from
 * CSV, refuse-don't-guess.
 *
 *   dryRun     maps and validates every row against the mapping file and the
 *              facility, and returns the report: counts, every refused row
 *              with its reason, the columns dropped (identity numbers are
 *              never imported). It writes nothing at all.
 *   confirm    the hospital admin's run of a file whose dry run they saw: the
 *              same file and mapping (by the dry run's hash) or nothing.
 *              Patients (new UHIDs), review items and CLOSED encounters, in
 *              chunks of ~500 rows (Flagship 3d), each chunk one transaction
 *              with each row's own import event; no live consumer listens. A
 *              chunk that fails rolls back alone: the batch is FAILED, the
 *              chunks before it stay, and the same file resumes with no
 *              duplicates (each row's source key is unique per facility).
 *   review     (Flagship 3d) a re-imported patient whose details differ from
 *              the patient's now is never ignored or updated silently: it waits
 *              in the hospital admin's review queue (review.ts), accepted or
 *              kept, each audited with a reason.
 *
 * Matching is by exact key only: a legacy MRN already imported at this
 * facility is that patient; nothing else ever matches (not a name, a date of
 * birth or a phone). Imported patients are never linked to a Person. Running
 * the same file again is a no-op (the file hash, and each row's source key,
 * are unique per facility).
 */

export const IMPORT_WINDOW_YEARS = 3;
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
/** Flagship 3d: rows per chunk; each chunk is one transaction. */
export const IMPORT_CHUNK_ROWS = 500;
/** Lookups by key, in slices well under Postgres's bind-parameter limit. */
const LOOKUP_SLICE = 5_000;
const DATE_FORMATS = ["DD/MM/YYYY", "DD-MM-YYYY", "YYYY-MM-DD", "MM/DD/YYYY"] as const;
/** Identity numbers are never imported: such a column is dropped at parse, and the report says so. */
const IDENTITY_COLUMN = /aadhaa?r|\bpan\b|pan[\s_-]?(no|number)|\buid(ai)?\b|voter|passport/i;

const ProfileSchema = z.object({
  sourceSystem: z.string().trim().min(1).max(60),
  dateFormat: z.enum(DATE_FORMATS),
  patients: z.object({
    columns: z.object({ mrn: z.string(), fullName: z.string(), sex: z.string(), dob: z.string().optional(), phone: z.string().optional() }).strict(),
    sex: z.record(z.string(), z.enum(["M", "F", "O"])),
  }).strict(),
  encounters: z.object({
    columns: z.object({ mrn: z.string(), visitNumber: z.string(), type: z.string(), registeredAt: z.string(), closedAt: z.string().optional(), department: z.string().optional(), clinician: z.string().optional() }).strict(),
    type: z.record(z.string(), z.enum(["OPD", "ED", "IPD", "DAYCARE", "TELEMEDICINE"])),
    /** The source's department codes to this facility's department names (exactly). */
    departments: z.record(z.string(), z.string()).default({}),
  }).strict().optional(),
}).strict();
export type ImportProfile = z.infer<typeof ProfileSchema>;

export type RefusalReason = "MISSING_FIELD" | "BAD_DATE" | "DATE_OUT_OF_RANGE" | "OLDER_THAN_WINDOW" | "UNMAPPED_VALUE" | "DUPLICATE_KEY_CONFLICT" | "UNKNOWN_PATIENT" | "INVALID_PHONE" | "CLOSED_BEFORE_REGISTERED" | "UNKNOWN_DEPARTMENT"
  // Flagship 5 (HL7): an admission still open at cut-over (the manual checklist, §10.7), a message type this import doesn't read, an unmapped test or unit, a result not final.
  | "OPEN_ADMISSION" | "UNSUPPORTED_MESSAGE" | "UNMAPPED_TEST" | "UNIT_UNMAPPED" | "NOT_FINAL" | "NOT_NUMERIC";
/** `line`: the CSV line, or (HL7) the message's number in the file. */
export interface Refusal { file: "patients" | "encounters" | "results" | "messages"; line: number; sourceKey: string | null; reason: RefusalReason; detail: string }

export interface PatientPlan { mrn: string; fullName: string; sex: "M" | "F" | "O"; dob: Date | null; phone: string | null }
/** The details a re-import compares, in a stable shape (dates as YYYY-MM-DD instants in ISO). */
type PatientDetails = { fullName: string; sex: string; dob: string | null; phone: string | null };
const DETAIL_FIELDS = ["fullName", "sex", "dob", "phone"] as const;
export interface ReviewPlan { mrn: string; patientId: string; incoming: PatientDetails; existing: PatientDetails; differences: string[]; incomingHash: string }
export interface EncounterPlan { visitNumber: string; mrn: string; type: EncounterType; registeredAt: Date; closedAt: Date | null; departmentId: string | null; clinician: string | null }

export interface ResultPlan { sourceKey: string; mrn: string; visitNumber: string | null; testCode: string; testName: string; value: string; numericValue: number | null; unit: string | null; originalValue: string | null; originalUnit: string | null; referenceRange: string | null; abnormalFlag: string | null; observedAt: Date }
export interface ImportPlan { patients: PatientPlan[]; reviews: ReviewPlan[]; encounters: EncounterPlan[]; results: ResultPlan[] }

export interface ImportInput { profile?: unknown; patientsCsv?: unknown; encountersCsv?: unknown; /** Flagship 5: an HL7 v2 file (ADT and ORU messages). */ hl7?: unknown }

function parseInput(body: ImportInput) {
  const parsed = ProfileSchema.safeParse(body.profile);
  if (!parsed.success) throw new BadRequestError("The mapping file is not valid.", { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  const profile = parsed.data;
  const patientsCsv = typeof body.patientsCsv === "string" ? body.patientsCsv : "";
  const encountersCsv = typeof body.encountersCsv === "string" ? body.encountersCsv : "";
  if (!patientsCsv && !encountersCsv) throw new BadRequestError("A patients or an encounters CSV is required.");
  if (Buffer.byteLength(patientsCsv) + Buffer.byteLength(encountersCsv) > MAX_IMPORT_BYTES) throw new BadRequestError(`At most ${MAX_IMPORT_BYTES / 1024 / 1024} MB per import; split the file.`);
  if (encountersCsv && !profile.encounters) throw new BadRequestError("The mapping file has no encounters section.");
  for (const col of [...Object.values(profile.patients.columns), ...Object.values(profile.encounters?.columns ?? {})]) {
    if (col && IDENTITY_COLUMN.test(col)) throw new BadRequestError(`The mapping uses "${col}", an identity-number column; those are never imported.`);
  }
  const fileHash = createHash("sha256").update(JSON.stringify({ profile, patientsCsv, encountersCsv })).digest("hex");
  return { profile, patientsCsv, encountersCsv, fileHash };
}

/** A date (and optional HH:mm) in the declared format, as the instant in the facility's zone; null when it doesn't parse exactly. */
export function parseLegacyDate(raw: string, format: ImportProfile["dateFormat"], timeZone: string): Date | null {
  const m = /^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(raw.trim());
  if (!m) return null;
  const [a, b, c] = [m[1], m[2], m[3]];
  const sep = raw.trim()[a.length];
  if ((format === "YYYY-MM-DD" || format === "DD-MM-YYYY") !== (sep === "-")) return null;
  let y: number, mo: number, d: number;
  if (format === "YYYY-MM-DD") { if (a.length !== 4) return null; [y, mo, d] = [+a, +b, +c]; }
  else { if (c.length !== 4) return null; y = +c; [d, mo] = format === "MM/DD/YYYY" ? [+b, +a] : [+a, +b]; }
  const key = `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const check = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== key) return null;
  const hh = m[4] !== undefined ? +m[4] : 0, mm = m[5] !== undefined ? +m[5] : 0;
  if (hh > 23 || mm > 59) return null;
  return zonedInstant(key, hh * 60 + mm, timeZone);
}

const details = (p: { fullName: string; sex: string; dob: Date | null; phone: string | null }): PatientDetails =>
  ({ fullName: p.fullName, sex: p.sex, dob: p.dob ? p.dob.toISOString() : null, phone: p.phone });
const hashOf = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

/** Rows of `kind` already imported at the facility from the source, by source key (sliced lookups). */
export async function knownKeys(facilityId: string, sourceSystem: string, kind: "PATIENT" | "ENCOUNTER" | "RESULT", keys: string[]) {
  const out = new Map<string, string>();
  for (let i = 0; i < keys.length; i += LOOKUP_SLICE) {
    for (const k of await prisma.legacyRecordKey.findMany({ where: { facilityId, sourceSystem, kind, sourceKey: { in: keys.slice(i, i + LOOKUP_SLICE) } }, select: { sourceKey: true, targetId: true } })) out.set(k.sourceKey, k.targetId);
  }
  return out;
}

export function normalizedPhone(raw: string): string | null {
  const digits = raw.replace(/[\s()-]/g, "");
  const m = /^(?:\+?91)?([6-9]\d{9})$/.exec(digits);
  return m ? `+91${m[1]}` : null;
}

/**
 * Patients against what this facility already imported from the source, by
 * exact MRN: new ones to create; a known MRN with the same details is a no-op;
 * one whose details differ (only the fields given) waits for review, once per
 * difference (Flagship 3d).
 */
export async function planPatients(facilityId: string, sourceSystem: string, patients: PatientPlan[]) {
  const known = await knownKeys(facilityId, sourceSystem, "PATIENT", patients.map((p) => p.mrn));
  const newPatients = patients.filter((p) => !known.has(p.mrn));
  // A re-imported MRN: the same details are a no-op; different ones wait for review (once per difference).
  const reviews: ReviewPlan[] = [];
  const again = patients.filter((p) => known.has(p.mrn));
  for (let i = 0; i < again.length; i += LOOKUP_SLICE) {
    const slice = again.slice(i, i + LOOKUP_SLICE);
    const rows = new Map((await prisma.patient.findMany({ where: { id: { in: slice.map((p) => known.get(p.mrn)!) } }, select: { id: true, fullName: true, sex: true, dob: true, phone: true } })).map((r) => [r.id, r]));
    const queued = new Set((await prisma.legacyPatientReview.findMany({ where: { facilityId, sourceSystem: sourceSystem, sourceKey: { in: slice.map((p) => p.mrn) } }, select: { sourceKey: true, incomingHash: true } })).map((r) => `${r.sourceKey}:${r.incomingHash}`));
    for (const p of slice) {
      const patientId = known.get(p.mrn)!;
      const now = rows.get(patientId);
      if (!now) continue;
      const incoming = details(p);
      const existing = details({ ...now, sex: String(now.sex) });
      // Only what the file gives: a date of birth or phone it doesn't carry is not a difference (nor ever a clearing).
      const differences = DETAIL_FIELDS.filter((f) => incoming[f] !== null && incoming[f] !== existing[f]);
      if (!differences.length) continue;
      const incomingHash = hashOf(incoming);
      if (queued.has(`${p.mrn}:${incomingHash}`)) continue;
      reviews.push({ mrn: p.mrn, patientId, incoming, existing, differences, incomingHash });
    }
  }

  return { newPatients, reviews, alreadyImported: patients.length - newPatients.length - reviews.length };
}

/** The CSV or the HL7 file (Flagship 5), evaluated: the report and the plan; writes nothing. */
async function evaluate(facilityId: string, body: ImportInput, now = new Date()) {
  if (body.hl7 !== undefined) return (await import("./hl7Import")).evaluateHl7(facilityId, body, now);
  return evaluateCsv(facilityId, body, now);
}

/** Maps and validates both files; reads the facility (departments, earlier imports), writes nothing. */
async function evaluateCsv(facilityId: string, body: ImportInput, now = new Date()) {
  const { profile, patientsCsv, encountersCsv, fileHash } = parseInput(body);
  const timeZone = await facilityTimeZone(prisma, facilityId);
  const refused: Refusal[] = [];
  const droppedColumns: string[] = [];
  const read = (text: string) => {
    if (!text) return { header: [] as string[], rows: [] as { line: number; get: (col: string | undefined) => string }[] };
    let parsed: ReturnType<typeof parseCsv>;
    try { parsed = parseCsv(text); } catch (e) { if (e instanceof CsvFormatError) throw new BadRequestError(`The CSV can't be read: ${e.message}`); throw e; }
    const { header, records } = parsed;
    for (const h of header) if (IDENTITY_COLUMN.test(h)) droppedColumns.push(h);
    const keep = header.map((h) => !IDENTITY_COLUMN.test(h));
    return {
      header,
      rows: records.map((r) => ({ line: r.line, get: (col: string | undefined) => { if (!col) return ""; const i = header.indexOf(col); return i >= 0 && keep[i] ? (r.values[i] ?? "").trim() : ""; } })),
    };
  };

  // Patients.
  const P = read(patientsCsv);
  const pc = profile.patients.columns;
  for (const col of [pc.mrn, pc.fullName, pc.sex]) if (patientsCsv && !P.header.includes(col)) throw new BadRequestError(`The patients file has no "${col}" column.`);
  const byMrn = new Map<string, { plan: PatientPlan; line: number; raw: string }[]>();
  for (const r of P.rows) {
    const mrn = r.get(pc.mrn);
    const refuse = (reason: RefusalReason, detail: string) => refused.push({ file: "patients", line: r.line, sourceKey: mrn || null, reason, detail });
    if (!mrn || !r.get(pc.fullName) || !r.get(pc.sex)) { refuse("MISSING_FIELD", "MRN, name and sex are required."); continue; }
    const sex = profile.patients.sex[r.get(pc.sex)];
    if (!sex) { refuse("UNMAPPED_VALUE", `Sex "${r.get(pc.sex)}" has no mapping.`); continue; }
    let dob: Date | null = null;
    if (pc.dob && r.get(pc.dob)) {
      dob = parseLegacyDate(r.get(pc.dob), profile.dateFormat, timeZone);
      if (!dob) { refuse("BAD_DATE", `Date of birth "${r.get(pc.dob)}" is not ${profile.dateFormat}.`); continue; }
      if (dob.getUTCFullYear() < 1900 || dob.getTime() > now.getTime()) { refuse("DATE_OUT_OF_RANGE", "Date of birth before 1900 or in the future."); continue; }
    }
    let phone: string | null = null;
    if (pc.phone && r.get(pc.phone)) {
      phone = normalizedPhone(r.get(pc.phone));
      if (!phone) { refuse("INVALID_PHONE", "Not an Indian mobile number."); continue; }
    }
    const plan: PatientPlan = { mrn, fullName: r.get(pc.fullName).slice(0, 200), sex, dob, phone };
    byMrn.set(mrn, [...(byMrn.get(mrn) ?? []), { plan, line: r.line, raw: JSON.stringify(plan) }]);
  }
  const patients: PatientPlan[] = [];
  for (const [mrn, rows] of byMrn) {
    if (new Set(rows.map((x) => x.raw)).size > 1) {
      for (const x of rows) refused.push({ file: "patients", line: x.line, sourceKey: mrn, reason: "DUPLICATE_KEY_CONFLICT", detail: "The same MRN twice with different details." });
      continue;
    }
    patients.push(rows[0].plan);
  }
  const { newPatients, reviews, alreadyImported } = await planPatients(facilityId, profile.sourceSystem, patients);

  // Encounters.
  const encounters: EncounterPlan[] = [];
  let encounterRows = 0;
  let knownEncounters = 0;
  if (encountersCsv && profile.encounters) {
    const E = read(encountersCsv);
    encounterRows = E.rows.length;
    const ec = profile.encounters.columns;
    for (const col of [ec.mrn, ec.visitNumber, ec.type, ec.registeredAt]) if (!E.header.includes(col)) throw new BadRequestError(`The encounters file has no "${col}" column.`);
    const departments = await prisma.department.findMany({ where: { facilityId }, select: { id: true, name: true } });
    const windowStart = new Date(now.getTime() - IMPORT_WINDOW_YEARS * 365.25 * 86_400_000);
    const acceptedMrns = new Set(patients.map((p) => p.mrn));
    const encMrns = [...new Set(E.rows.map((r) => r.get(ec.mrn)).filter(Boolean))];
    const knownPatientKeys = await knownKeys(facilityId, profile.sourceSystem, "PATIENT", encMrns);
    const byVisit = new Map<string, { plan: EncounterPlan; line: number; raw: string }[]>();
    for (const r of E.rows) {
      const visit = r.get(ec.visitNumber);
      const refuse = (reason: RefusalReason, detail: string) => refused.push({ file: "encounters", line: r.line, sourceKey: visit || null, reason, detail });
      const mrn = r.get(ec.mrn);
      if (!visit || !mrn || !r.get(ec.type) || !r.get(ec.registeredAt)) { refuse("MISSING_FIELD", "MRN, visit number, type and date are required."); continue; }
      if (!acceptedMrns.has(mrn) && !knownPatientKeys.has(mrn)) { refuse("UNKNOWN_PATIENT", "No accepted patient with this MRN (in this file or imported before)."); continue; }
      const type = profile.encounters.type[r.get(ec.type)];
      if (!type) { refuse("UNMAPPED_VALUE", `Visit type "${r.get(ec.type)}" has no mapping.`); continue; }
      const registeredAt = parseLegacyDate(r.get(ec.registeredAt), profile.dateFormat, timeZone);
      if (!registeredAt) { refuse("BAD_DATE", `Visit date "${r.get(ec.registeredAt)}" is not ${profile.dateFormat}.`); continue; }
      if (registeredAt.getTime() > now.getTime()) { refuse("DATE_OUT_OF_RANGE", "Visit date in the future."); continue; }
      if (registeredAt < windowStart) { refuse("OLDER_THAN_WINDOW", `Older than the ${IMPORT_WINDOW_YEARS}-year import window.`); continue; }
      let closedAt: Date | null = null;
      if (ec.closedAt && r.get(ec.closedAt)) {
        closedAt = parseLegacyDate(r.get(ec.closedAt), profile.dateFormat, timeZone);
        if (!closedAt) { refuse("BAD_DATE", `Close date "${r.get(ec.closedAt)}" is not ${profile.dateFormat}.`); continue; }
        if (closedAt < registeredAt || closedAt.getTime() > now.getTime()) { refuse("CLOSED_BEFORE_REGISTERED", "Closed before it was registered, or in the future."); continue; }
      }
      let departmentId: string | null = null;
      if (ec.department && r.get(ec.department)) {
        const name = profile.encounters.departments[r.get(ec.department)];
        if (!name) { refuse("UNMAPPED_VALUE", `Department "${r.get(ec.department)}" has no mapping.`); continue; }
        const dept = departments.find((d) => d.name === name);
        if (!dept) { refuse("UNKNOWN_DEPARTMENT", `"${name}" is not a department of this hospital.`); continue; }
        departmentId = dept.id;
      }
      // Kept as the old system wrote it; shown as "Recorded by: <name> (imported)" (decided §10.3, §10.10).
      const clinician = ec.clinician && r.get(ec.clinician) ? r.get(ec.clinician).slice(0, 120) : null;
      const plan: EncounterPlan = { visitNumber: visit, mrn, type, registeredAt, closedAt, departmentId, clinician };
      byVisit.set(visit, [...(byVisit.get(visit) ?? []), { plan, line: r.line, raw: JSON.stringify(plan) }]);
    }
    for (const [visit, rows] of byVisit) {
      if (new Set(rows.map((x) => x.raw)).size > 1) {
        for (const x of rows) refused.push({ file: "encounters", line: x.line, sourceKey: visit, reason: "DUPLICATE_KEY_CONFLICT", detail: "The same visit number twice with different details." });
        continue;
      }
      encounters.push(rows[0].plan);
    }
    const knownVisits = await knownKeys(facilityId, profile.sourceSystem, "ENCOUNTER", [...byVisit.keys()]);
    knownEncounters = encounters.filter((e) => knownVisits.has(e.visitNumber)).length;
    encounters.splice(0, encounters.length, ...encounters.filter((e) => !knownVisits.has(e.visitNumber)));
  }

  refused.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? 1 : -1));
  const counts = {
    patients: { rows: P.rows.length, toCreate: newPatients.length, alreadyImported, toReview: reviews.length, refused: refused.filter((r) => r.file === "patients").length },
    encounters: { rows: encounterRows, toCreate: encounters.length, alreadyImported: knownEncounters, refused: refused.filter((r) => r.file === "encounters").length },
  };
  const dryRunHash = createHash("sha256").update(JSON.stringify({ fileHash, facilityId, counts, refused })).digest("hex");
  return { profile, fileHash, timeZone, report: { sourceSystem: profile.sourceSystem, fileHash, dryRunHash, counts, refused, droppedColumns: [...new Set(droppedColumns)] }, plan: { patients: newPatients, reviews, encounters, results: [] } as ImportPlan };
}

/** The dry run: the full report, and nothing written. */
export async function dryRunImport(facilityId: string, body: ImportInput) {
  const { report } = await evaluate(facilityId, body);
  const existing = await prisma.legacyImportBatch.findUnique({ where: { facilityId_fileHash: { facilityId, fileHash: report.fileHash } }, select: { id: true, status: true } });
  return { ...report, alreadyImported: existing ? { batchId: existing.id, status: existing.status } : null };
}

/** Test seam (the gates' forced failure): runs inside each chunk's transaction, before it commits. */
export interface ConfirmOptions { beforeChunkCommit?: (chunk: number) => Promise<void> | void; chunkRows?: number }

const newId = () => `c${randomBytes(12).toString("hex")}`;
function randomUhid(facilityId: string): string {
  const code = facilityId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 4).toUpperCase();
  return `UHID-${code}-${randomBytes(5).toString("hex").slice(0, 8).toUpperCase()}`;
}
const chunksOf = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/**
 * The confirmed run, for the file and mapping the admin's dry run showed
 * (`dryRunHash`). The batch is recorded first (COMMITTING); then patients,
 * review items and encounters in chunks of ~500 rows, each chunk one
 * transaction (its rows, their keys, each row's event, the chunk's event and
 * the batch's progress). A chunk that fails rolls back alone and the batch is
 * FAILED (LegacyImportBatchFailed); the same file then resumes after the
 * chunks already in (LegacyImportBatchResumed), with no duplicates: every row
 * is skipped whose source key exists. The batch closes with
 * LegacyImportBatchCommitted; a finished file runs again as a no-op.
 */
export async function confirmImport(admin: { userId: string; facilityId: string }, body: ImportInput & { dryRunHash?: unknown }, opts: ConfirmOptions = {}) {
  const { profile, fileHash, report, plan } = await evaluate(admin.facilityId, body);
  const done = await prisma.legacyImportBatch.findUnique({ where: { facilityId_fileHash: { facilityId: admin.facilityId, fileHash } } });
  if (done?.status === "COMMITTED") return { status: "ALREADY_IMPORTED" as const, batchId: done.id, counts: done.counts };
  // A new run needs the dry run's hash; a run interrupted part-way (same file, by its hash) resumes.
  if (!done && body.dryRunHash !== report.dryRunHash) throw new ConflictError("This isn't the import the dry run showed (the file, the mapping or the hospital's data changed). Run the dry run again.");
  const organizationId = await facilityOrganizationId(prisma, admin.facilityId);
  // Each row's event in its chunk's transaction; the tenant resolved once for the run.
  const tenant = { organizationId, facilityId: admin.facilityId, actorUserId: admin.userId };

  let batch = done ?? await prisma.$transaction(async (tx) => {
    const b = await tx.legacyImportBatch.create({ data: { facilityId: admin.facilityId, sourceSystem: profile.sourceSystem, fileHash, status: "COMMITTING", counts: report.counts as unknown as Prisma.InputJsonValue, startedByUserId: admin.userId } });
    await emitDomainEvent(tx, { ...tenant, type: "LegacyImportBatchStarted", aggregateId: b.id, payload: { batchId: b.id, patients: plan.patients.length, reviews: plan.reviews.length, encounters: plan.encounters.length, ...(plan.results.length ? { results: plan.results.length } : {}) } });
    return b;
  }).catch((e) => {
    if (!isUnique(e)) throw e;
    throw new ConflictError("This file is being imported right now.");
  });
  if (batch.status === "FAILED") {
    batch = await prisma.$transaction(async (tx) => {
      const u = await tx.legacyImportBatch.updateMany({ where: { id: batch.id, status: "FAILED" }, data: { status: "COMMITTING" } });
      if (u.count !== 1) throw new ConflictError("This file is being imported right now.");
      await emitDomainEvent(tx, { ...tenant, type: "LegacyImportBatchResumed", aggregateId: batch.id, payload: { batchId: batch.id, chunksCommitted: batch.chunksCommitted } });
      return tx.legacyImportBatch.findUniqueOrThrow({ where: { id: batch.id } });
    });
  }
  const batchId = batch.id;
  const size = Math.max(1, Math.min(opts.chunkRows ?? IMPORT_CHUNK_ROWS, 2_000));
  let chunk = batch.chunksCommitted;
  const created = { patients: 0, reviews: 0, encounters: 0, results: 0 };

  /** One chunk: its writes, the chunk's event and the batch's progress, in one transaction (retried once on a key race). */
  const commitChunk = async (part: "PATIENTS" | "REVIEWS" | "ENCOUNTERS" | "RESULTS", write: (tx: Tx) => Promise<number>) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const n = await prisma.$transaction(async (tx) => {
          const rows = await write(tx);
          await opts.beforeChunkCommit?.(chunk);
          await tx.legacyImportBatch.update({ where: { id: batchId }, data: { chunksCommitted: { increment: 1 } } });
          await emitDomainEvent(tx, { ...tenant, type: "LegacyImportChunkCommitted", aggregateId: batchId, payload: { batchId, chunk, part, rows } });
          return rows;
        }, { timeout: 120_000, maxWait: 20_000 });
        chunk += 1;
        return n;
      } catch (e) {
        if (isUnique(e) && attempt < 2) continue; // a UHID or key taken meanwhile: the chunk again, skipping what exists
        await prisma.$transaction(async (tx) => {
          await tx.legacyImportBatch.update({ where: { id: batchId }, data: { status: "FAILED", failedAt: new Date(), lastError: String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200) } });
          await emitDomainEvent(tx, { ...tenant, type: "LegacyImportBatchFailed", aggregateId: batchId, payload: { batchId, chunk, part } });
        });
        throw e;
      }
    }
  };

  // Patients: new UHIDs; an MRN whose key exists by now (an earlier chunk, a resumed run) is skipped.
  for (const part of chunksOf(plan.patients, size)) {
    created.patients += await commitChunk("PATIENTS", async (tx) => {
      const have = new Set((await tx.legacyRecordKey.findMany({ where: { facilityId: admin.facilityId, sourceSystem: profile.sourceSystem, kind: "PATIENT", sourceKey: { in: part.map((p) => p.mrn) } }, select: { sourceKey: true } })).map((k) => k.sourceKey));
      const todo = part.filter((p) => !have.has(p.mrn));
      if (!todo.length) return 0;
      const rows = todo.map((p) => ({ p, id: newId(), uhid: randomUhid(admin.facilityId) }));
      const taken = new Set((await tx.patient.findMany({ where: { uhid: { in: rows.map((r) => r.uhid) } }, select: { uhid: true } })).map((x) => x.uhid));
      for (const r of rows) while (taken.has(r.uhid)) r.uhid = randomUhid(admin.facilityId);
      await tx.patient.createMany({ data: rows.map(({ p, id, uhid }) => ({ id, facilityId: admin.facilityId, uhid, fullName: p.fullName, sex: p.sex, dob: p.dob, phone: p.phone, importBatchId: batchId })) });
      await tx.legacyRecordKey.createMany({ data: rows.map(({ p, id }) => ({ facilityId: admin.facilityId, sourceSystem: profile.sourceSystem, kind: "PATIENT" as const, sourceKey: p.mrn, targetId: id, batchId })) });
      for (const r of rows) await emitDomainEvent(tx, { ...tenant, type: "LegacyPatientImported", aggregateId: r.id, payload: { patientId: r.id, batchId } });
      return rows.length;
    });
  }
  // Re-imported patients whose details differ: into the hospital admin's review queue, never applied here.
  for (const part of chunksOf(plan.reviews, size)) {
    created.reviews += await commitChunk("REVIEWS", async (tx) => {
      const have = new Set((await tx.legacyPatientReview.findMany({ where: { facilityId: admin.facilityId, sourceSystem: profile.sourceSystem, sourceKey: { in: part.map((r) => r.mrn) } }, select: { sourceKey: true, incomingHash: true } })).map((r) => `${r.sourceKey}:${r.incomingHash}`));
      const todo = part.filter((r) => !have.has(`${r.mrn}:${r.incomingHash}`)).map((r) => ({ r, id: newId() }));
      if (!todo.length) return 0;
      await tx.legacyPatientReview.createMany({
        data: todo.map(({ r, id }) => ({ id, facilityId: admin.facilityId, batchId, sourceSystem: profile.sourceSystem, sourceKey: r.mrn, patientId: r.patientId, incoming: r.incoming, existing: r.existing, differences: r.differences, incomingHash: r.incomingHash })),
      });
      for (const { r, id } of todo) await emitDomainEvent(tx, { ...tenant, type: "LegacyPatientReviewQueued", aggregateId: id, payload: { reviewId: id, patientId: r.patientId, batchId, differences: r.differences } });
      return todo.length;
    });
  }
  // Encounters, CLOSED, for patients imported in this file or before (by exact key).
  for (const part of chunksOf(plan.encounters, size)) {
    created.encounters += await commitChunk("ENCOUNTERS", async (tx) => {
      const have = new Set((await tx.legacyRecordKey.findMany({ where: { facilityId: admin.facilityId, sourceSystem: profile.sourceSystem, kind: "ENCOUNTER", sourceKey: { in: part.map((e) => e.visitNumber) } }, select: { sourceKey: true } })).map((k) => k.sourceKey));
      const patientOf = new Map((await tx.legacyRecordKey.findMany({ where: { facilityId: admin.facilityId, sourceSystem: profile.sourceSystem, kind: "PATIENT", sourceKey: { in: [...new Set(part.map((e) => e.mrn))] } }, select: { sourceKey: true, targetId: true } })).map((k) => [k.sourceKey, k.targetId]));
      const rows = part.filter((e) => !have.has(e.visitNumber) && patientOf.has(e.mrn)).map((e) => ({ e, id: newId(), patientId: patientOf.get(e.mrn)! }));
      if (!rows.length) return 0;
      await tx.encounter.createMany({ data: rows.map(({ e, id, patientId }) => ({ id, facilityId: admin.facilityId, patientId, type: e.type, status: "CLOSED" as const, registeredAt: e.registeredAt, closedAt: e.closedAt ?? e.registeredAt, departmentId: e.departmentId, importBatchId: batchId })) });
      await tx.legacyRecordKey.createMany({ data: rows.map(({ e, id }) => ({ facilityId: admin.facilityId, sourceSystem: profile.sourceSystem, kind: "ENCOUNTER" as const, sourceKey: e.visitNumber, targetId: id, batchId, clinicianName: e.clinician })) });
      for (const r of rows) await emitDomainEvent(tx, { ...tenant, type: "LegacyEncounterImported", aggregateId: r.id, payload: { encounterId: r.id, patientId: r.patientId, batchId, encounterType: r.e.type }, correlationId: r.id });
      return rows.length;
    });
  }

  // Flagship 5: results (HL7 ORU), for patients imported in this file or before, never into the live LabResult.
  for (const part of chunksOf(plan.results, size)) {
    created.results += await commitChunk("RESULTS", async (tx) => {
      const have = new Set((await tx.legacyRecordKey.findMany({ where: { facilityId: admin.facilityId, sourceSystem: profile.sourceSystem, kind: "RESULT", sourceKey: { in: part.map((r) => r.sourceKey) } }, select: { sourceKey: true } })).map((k) => k.sourceKey));
      const keyOf = async (kind: "PATIENT" | "ENCOUNTER", keys: string[]) => new Map((await tx.legacyRecordKey.findMany({ where: { facilityId: admin.facilityId, sourceSystem: profile.sourceSystem, kind, sourceKey: { in: [...new Set(keys)] } }, select: { sourceKey: true, targetId: true } })).map((k) => [k.sourceKey, k.targetId]));
      const patientOf = await keyOf("PATIENT", part.map((r) => r.mrn));
      const encounterOf = await keyOf("ENCOUNTER", part.map((r) => r.visitNumber).filter((x): x is string => !!x));
      const rows = part.filter((r) => !have.has(r.sourceKey) && patientOf.has(r.mrn)).map((r) => ({ r, id: newId(), patientId: patientOf.get(r.mrn)!, encounterId: r.visitNumber ? encounterOf.get(r.visitNumber) ?? null : null }));
      if (!rows.length) return 0;
      await tx.legacyLabResult.createMany({ data: rows.map(({ r, id, patientId, encounterId }) => ({ id, facilityId: admin.facilityId, patientId, encounterId, batchId, sourceSystem: profile.sourceSystem, testCode: r.testCode, testName: r.testName, value: r.value, numericValue: r.numericValue, unit: r.unit, originalValue: r.originalValue, originalUnit: r.originalUnit, referenceRange: r.referenceRange, abnormalFlag: r.abnormalFlag, observedAt: r.observedAt })) });
      await tx.legacyRecordKey.createMany({ data: rows.map(({ r, id }) => ({ facilityId: admin.facilityId, sourceSystem: profile.sourceSystem, kind: "RESULT" as const, sourceKey: r.sourceKey, targetId: id, batchId })) });
      for (const x of rows) await emitDomainEvent(tx, { ...tenant, type: "LegacyResultImported", aggregateId: x.id, payload: { resultId: x.id, patientId: x.patientId, batchId, converted: x.r.originalUnit !== null } });
      return rows.length;
    });
  }

  const totals = await prisma.$transaction(async (tx) => {
    // Totals over the whole batch, so a resumed run counts the chunks committed before it too.
    const [patients, encounters, reviews] = await Promise.all([
      tx.legacyRecordKey.count({ where: { batchId, kind: "PATIENT" } }), tx.legacyRecordKey.count({ where: { batchId, kind: "ENCOUNTER" } }), tx.legacyPatientReview.count({ where: { batchId } }),
    ]);
    const b = await tx.legacyImportBatch.updateMany({ where: { id: batchId, status: "COMMITTING" }, data: { status: "COMMITTED", committedAt: new Date(), committedByUserId: admin.userId } });
    if (b.count !== 1) throw new ConflictError("This file is being imported right now.");
    await emitDomainEvent(tx, { ...tenant, type: "LegacyImportBatchCommitted", aggregateId: batchId, payload: { batchId, patients, encounters, refused: report.refused.length } });
    return { patients, encounters, reviews };
  });
  await recordAuditEvent("hospital.legacy-import.committed", admin.userId, { batchId, sourceSystem: profile.sourceSystem, ...totals, refused: report.refused.length, chunks: chunk }, { facilityId: admin.facilityId });
  return { status: "COMMITTED" as const, batchId, counts: report.counts, created: { patients: totals.patients, encounters: totals.encounters }, queuedForReview: totals.reviews, thisRun: created, chunks: chunk, refused: report.refused };
}

function isUnique(e: unknown) { return (e as { code?: string })?.code === "P2002"; }

/** One batch, this facility's only (another facility's id is a 404). */
export async function getImportBatch(facilityId: string, batchId: string) {
  const b = await prisma.legacyImportBatch.findUnique({ where: { id: batchId } });
  if (!b || b.facilityId !== facilityId) throw new NotFoundError("Import not found.");
  return b;
}
