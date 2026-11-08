import { createHash } from "node:crypto";
import type { EncounterType, Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { generateCandidateUhid } from "@/lib/hospital/uhid";
import { facilityTimeZone, zonedInstant } from "@/lib/time/zone";
import { CsvFormatError, parseCsv } from "./csv";

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
 *              Patients (new UHIDs) and CLOSED encounters, one transaction per
 *              row, each with its own import event; no live consumer listens.
 *
 * Matching is by exact key only: a legacy MRN already imported at this
 * facility is that patient; nothing else ever matches (not a name, a date of
 * birth or a phone). Imported patients are never linked to a Person. Running
 * the same file again is a no-op (the file hash, and each row's source key,
 * are unique per facility).
 */

export const IMPORT_WINDOW_YEARS = 3;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
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

export type RefusalReason = "MISSING_FIELD" | "BAD_DATE" | "DATE_OUT_OF_RANGE" | "OLDER_THAN_WINDOW" | "UNMAPPED_VALUE" | "DUPLICATE_KEY_CONFLICT" | "UNKNOWN_PATIENT" | "INVALID_PHONE" | "CLOSED_BEFORE_REGISTERED" | "UNKNOWN_DEPARTMENT";
export interface Refusal { file: "patients" | "encounters"; line: number; sourceKey: string | null; reason: RefusalReason; detail: string }

interface PatientPlan { mrn: string; fullName: string; sex: "M" | "F" | "O"; dob: Date | null; phone: string | null }
interface EncounterPlan { visitNumber: string; mrn: string; type: EncounterType; registeredAt: Date; closedAt: Date | null; departmentId: string | null; clinician: string | null }

export interface ImportInput { profile?: unknown; patientsCsv?: unknown; encountersCsv?: unknown }

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

function normalizedPhone(raw: string): string | null {
  const digits = raw.replace(/[\s()-]/g, "");
  const m = /^(?:\+?91)?([6-9]\d{9})$/.exec(digits);
  return m ? `+91${m[1]}` : null;
}

/** Maps and validates both files; reads the facility (departments, earlier imports), writes nothing. */
async function evaluate(facilityId: string, body: ImportInput, now = new Date()) {
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
  const known = new Set((await prisma.legacyRecordKey.findMany({ where: { facilityId, sourceSystem: profile.sourceSystem, kind: "PATIENT", sourceKey: { in: [...byMrn.keys()] } }, select: { sourceKey: true } })).map((k) => k.sourceKey));
  const newPatients = patients.filter((p) => !known.has(p.mrn));

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
    const knownPatientKeys = new Set((await prisma.legacyRecordKey.findMany({ where: { facilityId, sourceSystem: profile.sourceSystem, kind: "PATIENT", sourceKey: { in: encMrns } }, select: { sourceKey: true } })).map((k) => k.sourceKey));
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
      const clinician = ec.clinician && r.get(ec.clinician) ? `${r.get(ec.clinician).slice(0, 120)} (legacy)` : null;
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
    const knownVisits = new Set((await prisma.legacyRecordKey.findMany({ where: { facilityId, sourceSystem: profile.sourceSystem, kind: "ENCOUNTER", sourceKey: { in: [...byVisit.keys()] } }, select: { sourceKey: true } })).map((k) => k.sourceKey));
    knownEncounters = encounters.filter((e) => knownVisits.has(e.visitNumber)).length;
    encounters.splice(0, encounters.length, ...encounters.filter((e) => !knownVisits.has(e.visitNumber)));
  }

  refused.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? 1 : -1));
  const counts = {
    patients: { rows: P.rows.length, toCreate: newPatients.length, alreadyImported: patients.length - newPatients.length, refused: refused.filter((r) => r.file === "patients").length },
    encounters: { rows: encounterRows, toCreate: encounters.length, alreadyImported: knownEncounters, refused: refused.filter((r) => r.file === "encounters").length },
  };
  const dryRunHash = createHash("sha256").update(JSON.stringify({ fileHash, facilityId, counts, refused })).digest("hex");
  return { profile, fileHash, timeZone, report: { sourceSystem: profile.sourceSystem, fileHash, dryRunHash, counts, refused, droppedColumns: [...new Set(droppedColumns)] }, plan: { patients: newPatients, encounters } };
}

/** The dry run: the full report, and nothing written. */
export async function dryRunImport(facilityId: string, body: ImportInput) {
  const { report } = await evaluate(facilityId, body);
  const existing = await prisma.legacyImportBatch.findUnique({ where: { facilityId_fileHash: { facilityId, fileHash: report.fileHash } }, select: { id: true, status: true } });
  return { ...report, alreadyImported: existing ? { batchId: existing.id, status: existing.status } : null };
}

/**
 * The confirmed run, for the file and mapping the admin's dry run showed
 * (`dryRunHash`). The batch is recorded first (COMMITTING), each row then
 * commits on its own with its key and event, and the batch closes with
 * LegacyImportBatchCommitted. A run interrupted part-way resumes where it
 * stopped; a finished file runs again as a no-op.
 */
export async function confirmImport(admin: { userId: string; facilityId: string }, body: ImportInput & { dryRunHash?: unknown }) {
  const { profile, fileHash, report, plan } = await evaluate(admin.facilityId, body);
  const done = await prisma.legacyImportBatch.findUnique({ where: { facilityId_fileHash: { facilityId: admin.facilityId, fileHash } } });
  if (done?.status === "COMMITTED") return { status: "ALREADY_IMPORTED" as const, batchId: done.id, counts: done.counts };
  // A new run needs the dry run's hash; a run interrupted part-way (same file, by its hash) resumes.
  if (!done && body.dryRunHash !== report.dryRunHash) throw new ConflictError("This isn't the import the dry run showed (the file, the mapping or the hospital's data changed). Run the dry run again.");

  const batch = done ?? await prisma.legacyImportBatch.create({ data: { facilityId: admin.facilityId, sourceSystem: profile.sourceSystem, fileHash, status: "COMMITTING", counts: report.counts as unknown as Prisma.InputJsonValue, startedByUserId: admin.userId } })
    .catch(async (e) => {
      if (!isUnique(e)) throw e;
      throw new ConflictError("This file is being imported right now.");
    });
  if (batch.status === "COMMITTED") return { status: "ALREADY_IMPORTED" as const, batchId: batch.id, counts: batch.counts };
  const patientIdByMrn = new Map<string, string>();
  let createdPatients = 0;
  let createdEncounters = 0;
  for (const p of plan.patients) {
    const id = await importPatient(admin, batch.id, profile.sourceSystem, p);
    if (id.created) createdPatients += 1;
    patientIdByMrn.set(p.mrn, id.patientId);
  }
  const missing = [...new Set(plan.encounters.map((e) => e.mrn).filter((m) => !patientIdByMrn.has(m)))];
  for (const k of await prisma.legacyRecordKey.findMany({ where: { facilityId: admin.facilityId, sourceSystem: profile.sourceSystem, kind: "PATIENT", sourceKey: { in: missing } }, select: { sourceKey: true, targetId: true } })) patientIdByMrn.set(k.sourceKey, k.targetId);
  for (const e of plan.encounters) {
    const patientId = patientIdByMrn.get(e.mrn);
    if (patientId && (await importEncounter(admin, batch.id, profile.sourceSystem, patientId, e))) createdEncounters += 1;
  }
  const committed = await prisma.$transaction(async (tx) => {
    const b = await tx.legacyImportBatch.update({ where: { id: batch.id }, data: { status: "COMMITTED", committedAt: new Date(), committedByUserId: admin.userId } });
    await emitFacilityEvent(tx, {
      type: "LegacyImportBatchCommitted", aggregateId: b.id, facilityId: admin.facilityId, actorUserId: admin.userId,
      payload: { batchId: b.id, patients: createdPatients, encounters: createdEncounters, refused: report.refused.length },
    });
    return b;
  });
  await recordAuditEvent("hospital.legacy-import.committed", admin.userId, { batchId: committed.id, sourceSystem: profile.sourceSystem, patients: createdPatients, encounters: createdEncounters, refused: report.refused.length }, { facilityId: admin.facilityId });
  return { status: "COMMITTED" as const, batchId: committed.id, counts: report.counts, created: { patients: createdPatients, encounters: createdEncounters }, refused: report.refused };
}

function isUnique(e: unknown) { return (e as { code?: string })?.code === "P2002"; }

async function importPatient(admin: { userId: string; facilityId: string }, batchId: string, sourceSystem: string, p: PatientPlan): Promise<{ patientId: string; created: boolean }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const uhid = await generateCandidateUhid(admin.facilityId);
    try {
      return await prisma.$transaction(async (tx) => {
        const patient = await tx.patient.create({ data: { facilityId: admin.facilityId, uhid, fullName: p.fullName, sex: p.sex, dob: p.dob, phone: p.phone, importBatchId: batchId } });
        await tx.legacyRecordKey.create({ data: { facilityId: admin.facilityId, sourceSystem, kind: "PATIENT", sourceKey: p.mrn, targetId: patient.id, batchId } });
        await emitFacilityEvent(tx, { type: "LegacyPatientImported", aggregateId: patient.id, facilityId: admin.facilityId, actorUserId: admin.userId, payload: { patientId: patient.id, batchId } });
        return { patientId: patient.id, created: true };
      });
    } catch (e) {
      if (!isUnique(e)) throw e;
      // The MRN was imported meanwhile (a resumed run): that patient, by its exact key.
      const k = await prisma.legacyRecordKey.findUnique({ where: { facilityId_sourceSystem_kind_sourceKey: { facilityId: admin.facilityId, sourceSystem, kind: "PATIENT", sourceKey: p.mrn } } });
      if (k) return { patientId: k.targetId, created: false };
      // Otherwise a UHID collision: try another.
    }
  }
  throw new Error("Could not generate a unique UHID.");
}

async function importEncounter(admin: { userId: string; facilityId: string }, batchId: string, sourceSystem: string, patientId: string, e: EncounterPlan): Promise<boolean> {
  try {
    return await prisma.$transaction(async (tx) => {
      const enc = await tx.encounter.create({ data: { facilityId: admin.facilityId, patientId, type: e.type, status: "CLOSED", registeredAt: e.registeredAt, closedAt: e.closedAt ?? e.registeredAt, departmentId: e.departmentId, importBatchId: batchId } });
      await tx.legacyRecordKey.create({ data: { facilityId: admin.facilityId, sourceSystem, kind: "ENCOUNTER", sourceKey: e.visitNumber, targetId: enc.id, batchId, clinicianName: e.clinician } });
      await emitFacilityEvent(tx, { type: "LegacyEncounterImported", aggregateId: enc.id, facilityId: admin.facilityId, actorUserId: admin.userId, encounterId: enc.id, payload: { encounterId: enc.id, patientId, batchId, encounterType: e.type } });
      return true;
    });
  } catch (err) {
    if (isUnique(err)) return false; // imported meanwhile (a resumed run)
    throw err;
  }
}

/** One batch, this facility's only (another facility's id is a 404). */
export async function getImportBatch(facilityId: string, batchId: string) {
  const b = await prisma.legacyImportBatch.findUnique({ where: { id: batchId } });
  if (!b || b.facilityId !== facilityId) throw new NotFoundError("Import not found.");
  return b;
}
