import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";
import { facilityTimeZone, zonedInstant } from "@/lib/time/zone";
import { comp, first, Hl7FormatError, parseHl7, parseHl7Time, reps, type Hl7Message, type Hl7Segment } from "./hl7";
import {
  IMPORT_WINDOW_YEARS, MAX_IMPORT_BYTES, knownKeys, normalizedPhone, planPatients,
  type EncounterPlan, type ImportInput, type ImportPlan, type PatientPlan, type Refusal, type RefusalReason, type ResultPlan,
} from "./service";

/**
 * Flagship 5 — legacy import phase 2: HL7 v2 ADT (patients, visits) and ORU
 * (results), with the CSV import's rules (docs/LEGACY_IMPORT_DESIGN.md §11.2):
 * a dry run that writes nothing and reports every refusal with the message it
 * came from; the confirmed run in chunks (service.ts confirmImport); exact
 * MRN keys only; a re-imported patient whose details differ goes to the
 * review queue; identity numbers never imported; the 3-year window.
 *
 *   ADT    A01, A03, A04 and A08 (admit, discharge, register, update). A visit
 *          is one PV1-19 visit number across its messages; an inpatient or ED
 *          visit with no discharge is still open at cut-over, so it is
 *          refused (it comes in through the manual checklist, §10.7).
 *          Cancellations (A11, A13…) and other messages are refused.
 *   ORU    R01. Each OBX of a mapped test, final or corrected, for a patient
 *          accepted in this file or imported before. Units are converted only
 *          on an exact (test, unit) mapping; anything else is refused.
 *          Results never create patients.
 */

const IDENTITY_TYPES = new Set(["NI", "SS", "SSN", "NNIND", "AADHAAR", "AADHAR", "UID", "UIDAI", "PPN", "PAN", "VS", "DL", "VOTER"]);
const ADT_EVENTS = new Set(["A01", "A03", "A04", "A08"]);
const FINAL = new Set(["F", "C"]);
const CLASS_NEEDS_DISCHARGE = new Set(["IPD", "ED"]);

const Hl7ProfileSchema = z.object({
  sourceSystem: z.string().trim().min(1).max(60),
  format: z.literal("HL7V2"),
  /** The PID-3 identifier type that is the hospital's MRN (e.g. "MR"). */
  mrnIdentifierType: z.string().trim().min(1).max(12),
  sex: z.record(z.string(), z.enum(["M", "F", "O"])),
  /** PV1-2 patient class to the visit type (e.g. I → IPD, O → OPD, E → ED). */
  patientClass: z.record(z.string(), z.enum(["OPD", "ED", "IPD", "DAYCARE", "TELEMEDICINE"])),
  /** PV1-10 hospital service codes to this facility's department names (exactly). */
  departments: z.record(z.string(), z.string()).default({}),
  results: z.object({
    /** OBX-3 test code → this hospital's name and unit; `convert`: a sent unit → the factor to the mapped unit. */
    tests: z.record(z.string(), z.object({ name: z.string().trim().min(1).max(120), unit: z.string().max(40), convert: z.record(z.string(), z.number().positive()).default({}) }).strict()),
  }).strict().optional(),
}).strict();

function fullName(pid: Hl7Segment) {
  const n = reps(pid, 5)[0] ?? [];
  return [n[1], n[2], n[0]].map((x) => (x ?? "").trim()).filter(Boolean).join(" ").slice(0, 200);
}
function clinician(pv1: Hl7Segment) {
  const x = reps(pv1, 7)[0] ?? [];
  const name = [x[5], x[2], x[1]].map((v) => (v ?? "").trim()).filter(Boolean).join(" ");
  return name ? name.slice(0, 120) : null;
}
function phoneOf(pid: Hl7Segment) {
  for (const r of reps(pid, 13)) {
    const raw = (r[0] ?? "").trim() || `${(r[5] ?? "").trim()}${(r[6] ?? "").trim()}`;
    if (raw) return raw;
  }
  return "";
}

export async function evaluateHl7(facilityId: string, body: ImportInput, now = new Date()) {
  const parsed = Hl7ProfileSchema.safeParse(body.profile);
  if (!parsed.success) throw new BadRequestError("The mapping file is not valid for HL7.", { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  const profile = parsed.data;
  if (IDENTITY_TYPES.has(profile.mrnIdentifierType.toUpperCase())) throw new BadRequestError(`The mapping uses "${profile.mrnIdentifierType}", an identity-number type, as the MRN; those are never imported.`);
  const hl7 = typeof body.hl7 === "string" ? body.hl7 : "";
  if (!hl7) throw new BadRequestError("An HL7 file is required.");
  if (Buffer.byteLength(hl7) > MAX_IMPORT_BYTES) throw new BadRequestError(`At most ${MAX_IMPORT_BYTES / 1024 / 1024} MB per import; split the file.`);
  let messages: Hl7Message[];
  try { messages = parseHl7(hl7); } catch (e) { if (e instanceof Hl7FormatError) throw new BadRequestError(`The HL7 file can't be read: ${e.message}`); throw e; }
  const fileHash = createHash("sha256").update(JSON.stringify({ profile, hl7 })).digest("hex");
  const timeZone = await facilityTimeZone(prisma, facilityId);
  const zoned = (key: string, minute: number) => zonedInstant(key, minute, timeZone);
  const windowStart = new Date(now.getTime() - IMPORT_WINDOW_YEARS * 365.25 * 86_400_000);
  const refused: Refusal[] = [];
  const dropped = new Set<string>();
  const mrnOf = (pid: Hl7Segment | undefined) => {
    if (!pid) return "";
    let mrn = "";
    for (const r of reps(pid, 3)) {
      const type = (r[4] ?? "").trim().toUpperCase();
      if (IDENTITY_TYPES.has(type)) { dropped.add(`PID-3 (${type})`); continue; }
      if (type === profile.mrnIdentifierType.toUpperCase() && !mrn) mrn = (r[0] ?? "").trim();
    }
    if (comp(pid, 19)) dropped.add("PID-19 (a national identity number)");
    return mrn;
  };

  // ── ADT: patients and visits ──
  const byMrn = new Map<string, { plan: PatientPlan; line: number; raw: string }[]>();
  const visits = new Map<string, { line: number; mrn: string; cls: string; admit: string; discharge: string; dept: string; clinician: string | null }[]>();
  const oru: Hl7Message[] = [];
  for (const m of messages) {
    const [kind, event] = m.type.split("^");
    const refuse = (reason: RefusalReason, detail: string, file: Refusal["file"] = "messages", key: string | null = m.controlId || null) => refused.push({ file, line: m.index, sourceKey: key, reason, detail });
    if (kind === "ORU" && event === "R01") { oru.push(m); continue; }
    if (kind !== "ADT" || !ADT_EVENTS.has(event)) { refuse("UNSUPPORTED_MESSAGE", `${m.type || "A message with no type"} isn't imported (ADT A01, A03, A04, A08 and ORU R01 are).`); continue; }
    const pid = first(m, "PID");
    const mrn = mrnOf(pid);
    if (!pid || !mrn || !fullName(pid) || !comp(pid, 8)) { refuse("MISSING_FIELD", `The MRN (PID-3, type ${profile.mrnIdentifierType}), name and sex are required.`, "patients", mrn || null); continue; }
    const sex = profile.sex[comp(pid, 8)];
    if (!sex) { refuse("UNMAPPED_VALUE", `Sex "${comp(pid, 8)}" has no mapping.`, "patients", mrn); continue; }
    let dob: Date | null = null;
    if (comp(pid, 7)) {
      const t = parseHl7Time(comp(pid, 7), zoned);
      if (!t) { refuse("BAD_DATE", `Date of birth "${comp(pid, 7)}" is not an HL7 date.`, "patients", mrn); continue; }
      // A date of birth is a day: midnight of it in the facility's zone, whatever time was sent.
      const raw = comp(pid, 7);
      dob = zoned(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`, 0);
      if (dob.getUTCFullYear() < 1900 || dob.getTime() > now.getTime()) { refuse("DATE_OUT_OF_RANGE", "Date of birth before 1900 or in the future.", "patients", mrn); continue; }
    }
    let phone: string | null = null;
    if (phoneOf(pid)) {
      phone = normalizedPhone(phoneOf(pid));
      if (!phone) { refuse("INVALID_PHONE", "Not an Indian mobile number.", "patients", mrn); continue; }
    }
    const plan: PatientPlan = { mrn, fullName: fullName(pid), sex, dob, phone };
    byMrn.set(mrn, [...(byMrn.get(mrn) ?? []), { plan, line: m.index, raw: JSON.stringify(plan) }]);
    const pv1 = first(m, "PV1");
    const visit = comp(pv1, 19);
    if (pv1 && visit) {
      visits.set(visit, [...(visits.get(visit) ?? []), { line: m.index, mrn, cls: comp(pv1, 2), admit: comp(pv1, 44), discharge: comp(pv1, 45), dept: comp(pv1, 10), clinician: clinician(pv1) }]);
    }
  }
  const patients: PatientPlan[] = [];
  for (const [mrn, rows] of byMrn) {
    if (new Set(rows.map((x) => x.raw)).size > 1) {
      for (const x of rows) refused.push({ file: "patients", line: x.line, sourceKey: mrn, reason: "DUPLICATE_KEY_CONFLICT", detail: "The same MRN in two messages with different details." });
      continue;
    }
    patients.push(rows[0].plan);
  }
  const { newPatients, reviews, alreadyImported } = await planPatients(facilityId, profile.sourceSystem, patients);
  const accepted = new Set(patients.map((p) => p.mrn));
  const allMrns = [...new Set([...visits.values()].flat().map((v) => v.mrn).concat(oru.map((m) => mrnOf(first(m, "PID"))).filter(Boolean)))];
  const knownPatients = await knownKeys(facilityId, profile.sourceSystem, "PATIENT", allMrns);
  const isPatient = (mrn: string) => accepted.has(mrn) || knownPatients.has(mrn);

  const departments = await prisma.department.findMany({ where: { facilityId }, select: { id: true, name: true } });
  const encounters: EncounterPlan[] = [];
  for (const [visit, rows] of visits) {
    const refuse = (reason: RefusalReason, detail: string) => refused.push({ file: "encounters", line: rows[0].line, sourceKey: visit, reason, detail });
    const distinct = (f: (r: (typeof rows)[number]) => string) => [...new Set(rows.map(f).filter(Boolean))];
    const [mrns, classes, admits, discharges, depts] = [distinct((r) => r.mrn), distinct((r) => r.cls), distinct((r) => r.admit), distinct((r) => r.discharge), distinct((r) => r.dept)];
    if (mrns.length > 1 || classes.length > 1 || admits.length > 1 || discharges.length > 1 || depts.length > 1) { refuse("DUPLICATE_KEY_CONFLICT", "The same visit number in messages that disagree (patient, class, admission or discharge time, or service)."); continue; }
    const mrn = mrns[0];
    if (!isPatient(mrn)) { refuse("UNKNOWN_PATIENT", "No accepted patient with this MRN (in this file or imported before)."); continue; }
    if (!classes[0] || !admits[0]) { refuse("MISSING_FIELD", "The patient class (PV1-2) and the admission time (PV1-44) are required."); continue; }
    const type = profile.patientClass[classes[0]];
    if (!type) { refuse("UNMAPPED_VALUE", `Patient class "${classes[0]}" has no mapping.`); continue; }
    const reg = parseHl7Time(admits[0], zoned);
    if (!reg) { refuse("BAD_DATE", `Admission time "${admits[0]}" is not an HL7 date.`); continue; }
    if (reg.at.getTime() > now.getTime()) { refuse("DATE_OUT_OF_RANGE", "Admission time in the future."); continue; }
    if (reg.at < windowStart) { refuse("OLDER_THAN_WINDOW", `Older than the ${IMPORT_WINDOW_YEARS}-year import window.`); continue; }
    let closedAt: Date | null = null;
    if (discharges[0]) {
      const d = parseHl7Time(discharges[0], zoned);
      if (!d) { refuse("BAD_DATE", `Discharge time "${discharges[0]}" is not an HL7 date.`); continue; }
      if (d.at < reg.at || d.at.getTime() > now.getTime()) { refuse("CLOSED_BEFORE_REGISTERED", "Discharged before admission, or in the future."); continue; }
      closedAt = d.at;
    } else if (CLASS_NEEDS_DISCHARGE.has(type)) {
      refuse("OPEN_ADMISSION", "Still admitted at cut-over: brought in through the ward-by-ward checklist, not the file (§10.7)."); continue;
    }
    let departmentId: string | null = null;
    if (depts[0]) {
      const name = profile.departments[depts[0]];
      if (!name) { refuse("UNMAPPED_VALUE", `Hospital service "${depts[0]}" has no mapping.`); continue; }
      const dept = departments.find((d) => d.name === name);
      if (!dept) { refuse("UNKNOWN_DEPARTMENT", `"${name}" is not a department of this hospital.`); continue; }
      departmentId = dept.id;
    }
    encounters.push({ visitNumber: visit, mrn, type, registeredAt: reg.at, closedAt, departmentId, clinician: rows.map((r) => r.clinician).find(Boolean) ?? null });
  }
  const knownVisits = await knownKeys(facilityId, profile.sourceSystem, "ENCOUNTER", encounters.map((e) => e.visitNumber));
  const newEncounters = encounters.filter((e) => !knownVisits.has(e.visitNumber));

  // ── ORU: results ──
  const tests = profile.results?.tests ?? {};
  const byKey = new Map<string, { plan: ResultPlan; line: number; raw: string }[]>();
  let resultRows = 0;
  for (const m of oru) {
    const pid = first(m, "PID");
    const mrn = mrnOf(pid);
    const visit = comp(first(m, "PV1"), 19) || null;
    let obr: Hl7Segment | undefined;
    let obrIndex = 0;
    for (const seg of m.segments) {
      if (seg.name === "OBR") { obr = seg; obrIndex += 1; continue; }
      if (seg.name !== "OBX") continue;
      resultRows += 1;
      const code = comp(seg, 3, 1);
      const sourceKey = `${comp(obr, 3) || comp(obr, 2) || `${m.controlId}#${obrIndex}`}:${code}:${comp(seg, 4) || comp(seg, 1)}`;
      const refuse = (reason: RefusalReason, detail: string) => refused.push({ file: "results", line: m.index, sourceKey, reason, detail });
      if (!mrn) { refuse("MISSING_FIELD", `The MRN (PID-3, type ${profile.mrnIdentifierType}) is required.`); continue; }
      if (!isPatient(mrn)) { refuse("UNKNOWN_PATIENT", "No accepted patient with this MRN (in this file or imported before); results never create one."); continue; }
      const test = tests[code];
      if (!code || !test) { refuse("UNMAPPED_TEST", `Test "${code || "(none)"}" (OBX-3) has no mapping.`); continue; }
      if (!FINAL.has(comp(seg, 11))) { refuse("NOT_FINAL", `Result status "${comp(seg, 11) || "(none)"}" isn't final (F) or corrected (C).`); continue; }
      const when = comp(seg, 14) || comp(obr, 7);
      const t = when ? parseHl7Time(when, zoned) : null;
      if (!t) { refuse(when ? "BAD_DATE" : "MISSING_FIELD", when ? `Observation time "${when}" is not an HL7 date.` : "The observation time (OBX-14 or OBR-7) is required."); continue; }
      if (t.at.getTime() > now.getTime()) { refuse("DATE_OUT_OF_RANGE", "Observation time in the future."); continue; }
      if (t.at < windowStart) { refuse("OLDER_THAN_WINDOW", `Older than the ${IMPORT_WINDOW_YEARS}-year import window.`); continue; }
      const raw = comp(seg, 5);
      if (!raw) { refuse("MISSING_FIELD", "The value (OBX-5) is required."); continue; }
      const sentUnit = comp(seg, 6);
      const numeric = comp(seg, 2) === "NM";
      const unit: string | null = test.unit || null;
      let value = raw, numericValue: number | null = null, originalValue: string | null = null, originalUnit: string | null = null;
      if (numeric) {
        const n = Number(raw);
        if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw) || !Number.isFinite(n)) { refuse("NOT_NUMERIC", `"${raw}" isn't a number (OBX-2 is NM).`); continue; }
        if (sentUnit === test.unit) numericValue = n;
        else if (test.convert[sentUnit] !== undefined) {
          numericValue = Number((n * test.convert[sentUnit]).toPrecision(6));
          value = String(numericValue); originalValue = raw; originalUnit = sentUnit;
        } else { refuse("UNIT_UNMAPPED", `"${sentUnit || "(no unit)"}" for ${test.name} has no exact mapping to ${test.unit || "(no unit)"}.`); continue; }
      } else if (sentUnit && sentUnit !== test.unit) { refuse("UNIT_UNMAPPED", `"${sentUnit}" for ${test.name} has no exact mapping to ${test.unit || "(no unit)"}.`); continue; }
      const plan: ResultPlan = { sourceKey, mrn, visitNumber: visit, testCode: code, testName: test.name, value: value.slice(0, 200), numericValue, unit, originalValue, originalUnit, referenceRange: comp(seg, 7) || null, abnormalFlag: comp(seg, 8) || null, observedAt: t.at };
      byKey.set(sourceKey, [...(byKey.get(sourceKey) ?? []), { plan, line: m.index, raw: JSON.stringify(plan) }]);
    }
  }
  const results: ResultPlan[] = [];
  for (const [key, rows] of byKey) {
    if (new Set(rows.map((x) => x.raw)).size > 1) {
      for (const x of rows) refused.push({ file: "results", line: x.line, sourceKey: key, reason: "DUPLICATE_KEY_CONFLICT", detail: "The same result twice with different values." });
      continue;
    }
    results.push(rows[0].plan);
  }
  const knownResults = await knownKeys(facilityId, profile.sourceSystem, "RESULT", results.map((r) => r.sourceKey));
  const newResults = results.filter((r) => !knownResults.has(r.sourceKey));

  refused.sort((a, b) => a.line - b.line || a.file.localeCompare(b.file));
  const countOf = (f: Refusal["file"]) => refused.filter((r) => r.file === f).length;
  const counts = {
    messages: { total: messages.length, refused: countOf("messages") },
    patients: { rows: [...byMrn.values()].reduce((n, x) => n + x.length, 0), toCreate: newPatients.length, alreadyImported, toReview: reviews.length, refused: countOf("patients") },
    encounters: { rows: visits.size, toCreate: newEncounters.length, alreadyImported: encounters.length - newEncounters.length, refused: countOf("encounters") },
    results: { rows: resultRows, toCreate: newResults.length, alreadyImported: results.length - newResults.length, converted: newResults.filter((r) => r.originalUnit !== null).length, refused: countOf("results") },
  };
  const dryRunHash = createHash("sha256").update(JSON.stringify({ fileHash, facilityId, counts, refused })).digest("hex");
  const plan: ImportPlan = { patients: newPatients, reviews, encounters: newEncounters, results: newResults };
  return { profile: { sourceSystem: profile.sourceSystem }, fileHash, timeZone, report: { sourceSystem: profile.sourceSystem, format: "HL7V2" as const, fileHash, dryRunHash, counts, refused, droppedColumns: [...dropped] }, plan };
}
