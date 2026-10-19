import type { RagAudience, RagCategory, RagOrigin, RagSensitiveCategory, RagSourceType } from "@prisma/client";
import { sensitiveCategoryOf } from "./sensitivity";

/**
 * Week 4b — one renderer per source type (docs/RAG_DESIGN.md §5.3): the
 * source, already loaded by the indexer through the service layer, becomes
 * headed sections of plain text, with its sharing categories, its sensitive
 * category (placeholder map) and who may see it. Structured rows become one
 * dated sentence; codes are expanded to their display names; values, units
 * and ranges are copied exactly. Pure: no database.
 */
export type SourceInput =
  | { sourceType: "CLINICAL_NOTE"; noteType: string; content: unknown; at: Date; amended: boolean }
  | { sourceType: "LAB_RESULT"; testName: string; value: string; unit?: string | null; referenceRange?: string | null; flag?: string | null; critical?: boolean; at: Date; amended: boolean }
  | { sourceType: "IMAGING_REPORT"; study: string; indication?: string | null; technique?: string | null; findings: string; impression: string; recommendations?: string | null; at: Date; amended: boolean }
  | { sourceType: "DIAGNOSIS"; diagnosis: string; code?: string | null; codeDisplay?: string | null; type: string; status: string; onsetDate?: Date | null; at: Date }
  | { sourceType: "PROBLEM"; diagnosis: string; code?: string | null; codeDisplay?: string | null; status: string; severity?: string | null; onsetDate?: Date | null; at: Date }
  | { sourceType: "ALLERGY"; substance: string; reaction?: string | null; severity?: string | null; status: string; verification: string; patientReported: boolean; at: Date }
  | { sourceType: "ALLERGY_STATUS"; status: "NO_KNOWN_ALLERGIES" | "UNKNOWN" | "HAS_ALLERGIES"; at: Date }
  | { sourceType: "OBSERVATION"; day: Date; rows: { at: Date; hr?: number | null; sbp?: number | null; dbp?: number | null; rr?: number | null; spo2?: number | null; tempC?: number | null; painScore?: number | null }[] }
  | { sourceType: "REFERRAL"; reason: string; to?: string | null; priority: string; status: string; notes?: string | null; at: Date }
  | { sourceType: "DISCHARGE_SUMMARY"; summary: unknown; dischargeType?: string | null; at: Date }
  | { sourceType: "GENERATED_DOCUMENT" | "CLINICAL_DOCUMENT"; docType: string; title: string; patientVisible: boolean; at: Date }
  | { sourceType: "PATIENT_PROVIDED_RECORD"; kind: "DIAGNOSIS" | "MEDICATION_HISTORY" | "LAB_RESULT" | "PROCEDURE" | "ALLERGY"; value: Record<string, unknown>; at: Date; handwritten: boolean; documentTitle?: string | null }
  | { sourceType: "PATIENT_DOCUMENT"; docType: string; title: string; at: Date };

export interface Rendered {
  sourceType: RagSourceType;
  title: string;
  /** "Lab result", "Progress note", … */
  label: string;
  recordedAt: Date;
  sections: { heading?: string; text: string }[];
  categories: RagCategory[];
  sensitiveCategory: RagSensitiveCategory | null;
  audience: RagAudience;
  origin: RagOrigin;
  handwritten: boolean;
  /** "[Lab result · Hemoglobin · 2026-10-14 · verified]" */
  context: string;
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const words = (k: string) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const sentence = (s: string) => { const t = s.trim(); return /[.!?।]$/.test(t) ? t : `${t}.`; };

/** Free-form JSON (a note's content, a discharge summary) as headed sections. */
export function jsonSections(v: unknown, heading?: string): { heading?: string; text: string }[] {
  if (v === null || v === undefined || v === "") return [];
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [{ heading, text: String(v) }];
  if (Array.isArray(v)) {
    const flat = v.filter((x) => x !== null && typeof x !== "object").map(String);
    const nested = v.filter((x) => x !== null && typeof x === "object").flatMap((x) => jsonSections(x, heading));
    return [...(flat.length ? [{ heading, text: flat.join("\n") }] : []), ...nested];
  }
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => jsonSections(x, heading ? `${heading} — ${words(k)}` : words(k)));
}

const FLAG: Record<string, string> = { LOW: "low", HIGH: "high", CRITICAL_LOW: "critically low", CRITICAL_HIGH: "critically high", ABNORMAL: "abnormal", NORMAL: "within range", L: "low", H: "high", N: "within range" };

function docCategory(docType: string): RagCategory {
  const t = docType.toLowerCase();
  if (/prescription|rx/.test(t)) return "PRESCRIPTIONS";
  if (/discharge/.test(t)) return "DISCHARGE_SUMMARIES";
  if (/lab/.test(t)) return "LABS";
  if (/imaging|radiology|scan|x-?ray/.test(t)) return "IMAGING";
  if (/referral/.test(t)) return "REFERRALS";
  return "CLINICAL_NOTES";
}

const PP_CATEGORY: Record<string, RagCategory> = { DIAGNOSIS: "DIAGNOSES", MEDICATION_HISTORY: "PRESCRIPTIONS", LAB_RESULT: "LABS", PROCEDURE: "CLINICAL_NOTES", ALLERGY: "ALLERGIES" };

function base(sourceType: RagSourceType, label: string, title: string, at: Date, more: Partial<Rendered> & Pick<Rendered, "sections" | "categories">): Rendered {
  const origin = more.origin ?? "VERIFIED";
  const handwritten = more.handwritten ?? false;
  const originLabel = origin === "VERIFIED" ? "verified" : handwritten ? "patient-provided · handwritten" : "patient-provided";
  return {
    sourceType, label, title, recordedAt: at, origin, handwritten,
    sensitiveCategory: more.sensitiveCategory ?? null, audience: more.audience ?? "PATIENT_VISIBLE",
    sections: more.sections, categories: more.categories,
    context: `[${label} · ${title} · ${isoDay(at)} · ${originLabel}]`,
  };
}

export function renderSource(s: SourceInput): Rendered {
  switch (s.sourceType) {
    case "CLINICAL_NOTE": {
      const sections = jsonSections(s.content);
      const label = `${words(s.noteType.toLowerCase())} note`;
      return base("CLINICAL_NOTE", label, s.amended ? `${label} (amended)` : label, s.at, {
        sections: sections.length ? sections : [{ text: "(empty note)" }], categories: ["CLINICAL_NOTES"],
        // Clinicians' notes are for the care team; patient-facing modes don't read them.
        audience: "STAFF_ONLY",
        sensitiveCategory: sensitiveCategoryOf({ texts: [s.noteType, ...sections.map((x) => x.text)] }),
      });
    }
    case "LAB_RESULT": {
      const flag = s.flag ? FLAG[s.flag] ?? s.flag.toLowerCase() : null;
      const text = sentence(`${s.testName} ${s.value}${s.unit ? ` ${s.unit}` : ""}${s.referenceRange ? ` (reference ${s.referenceRange})` : ""}${flag ? `, ${flag}` : ""}${s.critical ? ", critical value" : ""}${s.amended ? ", amended result" : ""}, resulted ${isoDay(s.at)}`);
      return base("LAB_RESULT", "Lab result", s.testName, s.at, { sections: [{ text }], categories: ["LABS"], sensitiveCategory: sensitiveCategoryOf({ texts: [s.testName] }) });
    }
    case "IMAGING_REPORT": {
      const sections = [
        ...(s.indication ? [{ heading: "Indication", text: s.indication }] : []),
        ...(s.technique ? [{ heading: "Technique", text: s.technique }] : []),
        { heading: "Findings", text: s.findings },
        { heading: "Impression", text: s.impression },
        ...(s.recommendations ? [{ heading: "Recommendations", text: s.recommendations }] : []),
      ];
      return base("IMAGING_REPORT", "Imaging report", s.amended ? `${s.study} (amended)` : s.study, s.at, { sections, categories: ["IMAGING"], sensitiveCategory: sensitiveCategoryOf({ texts: [s.study, s.indication, s.impression] }) });
    }
    case "DIAGNOSIS": {
      const name = s.codeDisplay && s.codeDisplay !== s.diagnosis ? `${s.diagnosis} (${s.codeDisplay})` : s.diagnosis;
      const text = sentence(`Diagnosis: ${name}${s.code ? `, ICD-10 ${s.code}` : ""}; ${s.type.toLowerCase()}, ${s.status.toLowerCase().replace(/_/g, " ")}${s.onsetDate ? `; onset ${isoDay(s.onsetDate)}` : ""}; recorded ${isoDay(s.at)}`);
      return base("DIAGNOSIS", "Diagnosis", s.diagnosis, s.at, { sections: [{ text }], categories: ["DIAGNOSES"], sensitiveCategory: sensitiveCategoryOf({ code: s.code, texts: [s.diagnosis, s.codeDisplay] }) });
    }
    case "PROBLEM": {
      const text = sentence(`Problem list: ${s.diagnosis}${s.code ? `, ICD-10 ${s.code}` : ""}; ${s.status.toLowerCase()}${s.severity ? `, ${s.severity.toLowerCase()}` : ""}${s.onsetDate ? `; onset ${isoDay(s.onsetDate)}` : ""}; recorded ${isoDay(s.at)}`);
      return base("PROBLEM", "Problem", s.diagnosis, s.at, { sections: [{ text }], categories: ["DIAGNOSES"], sensitiveCategory: sensitiveCategoryOf({ code: s.code, texts: [s.diagnosis, s.codeDisplay] }) });
    }
    case "ALLERGY": {
      const text = sentence(`${s.patientReported ? "Patient-reported allergy" : "Allergy"}: ${s.substance}${s.reaction ? `, reaction ${s.reaction}` : ""}${s.severity ? `, ${s.severity.toLowerCase()}` : ", severity not recorded"}; ${s.status.toLowerCase().replace(/_/g, " ")}, ${s.verification.toLowerCase()}; recorded ${isoDay(s.at)}`);
      return base("ALLERGY", "Allergy", s.substance, s.at, { sections: [{ text }], categories: ["ALLERGIES"] });
    }
    case "ALLERGY_STATUS": {
      const text = { NO_KNOWN_ALLERGIES: "No known allergies", UNKNOWN: "Allergy status unknown (not recorded)", HAS_ALLERGIES: "Has allergies (see the allergy list)" }[s.status];
      return base("ALLERGY_STATUS", "Allergy status", text, s.at, { sections: [{ text: sentence(`Allergy status: ${text}; recorded ${isoDay(s.at)}`) }], categories: ["ALLERGIES"] });
    }
    case "OBSERVATION": {
      const lines = s.rows.map((r) => {
        const parts = [r.hr != null && `HR ${r.hr}/min`, r.sbp != null && r.dbp != null && `BP ${r.sbp}/${r.dbp} mmHg`, r.rr != null && `RR ${r.rr}/min`, r.spo2 != null && `SpO2 ${r.spo2}%`, r.tempC != null && `temp ${r.tempC} °C`, r.painScore != null && `pain ${r.painScore}/10`].filter(Boolean);
        return sentence(`Vitals at ${r.at.toISOString().slice(11, 16)} UTC: ${parts.join(", ")}`);
      });
      return base("OBSERVATION", "Vitals", isoDay(s.day), s.day, { sections: [{ text: lines.join("\n") }], categories: ["VITALS"] });
    }
    case "REFERRAL": {
      const text = sentence(`Referral${s.to ? ` to ${s.to}` : ""}: ${s.reason}; ${s.priority.toLowerCase()}, ${s.status.toLowerCase().replace(/_/g, " ")}; ${isoDay(s.at)}${s.notes ? `. ${s.notes}` : ""}`);
      return base("REFERRAL", "Referral", s.to ?? "Referral", s.at, { sections: [{ text }], categories: ["REFERRALS"], sensitiveCategory: sensitiveCategoryOf({ texts: [s.reason, s.notes, s.to] }) });
    }
    case "DISCHARGE_SUMMARY": {
      const sections = jsonSections(s.summary);
      return base("DISCHARGE_SUMMARY", "Discharge summary", `Discharge ${isoDay(s.at)}`, s.at, {
        sections: [{ text: sentence(`Discharged ${isoDay(s.at)}${s.dischargeType ? ` (${s.dischargeType.toLowerCase()})` : ""}`) }, ...sections],
        categories: ["DISCHARGE_SUMMARIES"], sensitiveCategory: sensitiveCategoryOf({ texts: sections.map((x) => x.text) }),
      });
    }
    case "GENERATED_DOCUMENT":
    case "CLINICAL_DOCUMENT": {
      const text = sentence(`${words(s.docType)} "${s.title}" issued ${isoDay(s.at)}`);
      return base(s.sourceType, "Document", s.title, s.at, { sections: [{ text }], categories: [docCategory(s.docType)], audience: s.patientVisible ? "PATIENT_VISIBLE" : "STAFF_ONLY", sensitiveCategory: sensitiveCategoryOf({ texts: [s.title, s.docType] }) });
    }
    case "PATIENT_PROVIDED_RECORD": {
      const v = s.value;
      const from = s.documentTitle ? ` (from the patient's document "${s.documentTitle}")` : " (from the patient's document)";
      const body = {
        DIAGNOSIS: () => `Patient-reported diagnosis: ${v.text}${v.icd10 ? `, ICD-10 ${v.icd10}` : ""}${v.status ? `, ${String(v.status).toLowerCase()}` : ""}`,
        MEDICATION_HISTORY: () => `Patient-reported medicine: ${[v.form, v.name, v.strength, v.dose, v.frequency].filter(Boolean).join(" ")}${v.duration ? ` for ${v.duration}` : ""}`,
        LAB_RESULT: () => `Patient-reported lab value: ${v.analyte} ${v.value}${v.unit ? ` ${v.unit}` : ""}${v.referenceRange ? ` (reference ${v.referenceRange})` : ""}${v.flag ? `, ${FLAG[String(v.flag)] ?? v.flag}` : ""}`,
        PROCEDURE: () => `Patient-reported procedure: ${v.text}${v.facilityName ? ` at ${v.facilityName}` : ""}`,
        ALLERGY: () => `Patient-reported allergy: ${v.substance}${v.reaction ? `, reaction ${v.reaction}` : ""}`,
      }[s.kind]();
      const title = String(v.analyte ?? v.name ?? v.substance ?? v.text ?? s.kind);
      return base("PATIENT_PROVIDED_RECORD", s.kind === "LAB_RESULT" ? "Uploaded lab value" : "Uploaded record", title, s.at, {
        sections: [{ text: sentence(`${body}${from}; dated ${isoDay(s.at)}${s.handwritten ? "; handwritten" : ""}`) }],
        categories: ["UPLOADS", PP_CATEGORY[s.kind]], origin: "PATIENT_PROVIDED", handwritten: s.handwritten,
        sensitiveCategory: sensitiveCategoryOf({ code: typeof v.icd10 === "string" ? v.icd10 : null, texts: [String(v.text ?? ""), String(v.analyte ?? ""), String(v.name ?? "")] }),
      });
    }
    case "PATIENT_DOCUMENT":
      return base("PATIENT_DOCUMENT", "Uploaded document", s.title, s.at, { sections: [{ text: sentence(`Uploaded ${words(s.docType).toLowerCase()} "${s.title}", ${isoDay(s.at)}; its contents are not confirmed yet`) }], categories: ["UPLOADS"], origin: "PATIENT_PROVIDED" });
  }
}
