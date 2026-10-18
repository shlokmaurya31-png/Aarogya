import { describe, expect, it } from "vitest";
import { $Enums } from "@prisma/client";
import { renderSource, jsonSections, type SourceInput } from "./render";
import { sensitiveCategoryOf } from "./sensitivity";
import { chunkSections, estimateTokens, sentences, CHUNK } from "./chunk";

/** Week 4b, RAG step 5: renderers (golden), categories, the sensitive map, the chunker. */
const at = new Date("2026-10-14T09:30:00Z");

const GOLDEN: [SourceInput, string, string, string[]][] = [
  [{ sourceType: "LAB_RESULT", testName: "Hemoglobin", value: "11.2", unit: "g/dL", referenceRange: "12.0 - 15.5", flag: "LOW", at, amended: false },
    "[Lab result · Hemoglobin · 2026-10-14 · verified]", "Hemoglobin 11.2 g/dL (reference 12.0 - 15.5), low, resulted 2026-10-14.", ["LABS"]],
  [{ sourceType: "LAB_RESULT", testName: "Creatinine", value: "1.10", unit: "mg/dL", flag: "NORMAL", at, amended: true },
    "[Lab result · Creatinine · 2026-10-14 · verified]", "Creatinine 1.10 mg/dL, within range, amended result, resulted 2026-10-14.", ["LABS"]],
  [{ sourceType: "DIAGNOSIS", diagnosis: "Type 2 diabetes mellitus", code: "E11.9", codeDisplay: "Type 2 diabetes mellitus without complications", type: "FINAL", status: "ACTIVE", at },
    "[Diagnosis · Type 2 diabetes mellitus · 2026-10-14 · verified]", "Diagnosis: Type 2 diabetes mellitus (Type 2 diabetes mellitus without complications), ICD-10 E11.9; final, active; recorded 2026-10-14.", ["DIAGNOSES"]],
  [{ sourceType: "PROBLEM", diagnosis: "Hypertension", code: "I10", status: "ACTIVE", severity: "MODERATE", at },
    "[Problem · Hypertension · 2026-10-14 · verified]", "Problem list: Hypertension, ICD-10 I10; active, moderate; recorded 2026-10-14.", ["DIAGNOSES"]],
  [{ sourceType: "ALLERGY", substance: "Penicillin", reaction: "rash", severity: "SEVERE", status: "ACTIVE", verification: "CONFIRMED", patientReported: false, at },
    "[Allergy · Penicillin · 2026-10-14 · verified]", "Allergy: Penicillin, reaction rash, severe; active, confirmed; recorded 2026-10-14.", ["ALLERGIES"]],
  [{ sourceType: "ALLERGY_STATUS", status: "NO_KNOWN_ALLERGIES", at },
    "[Allergy status · No known allergies · 2026-10-14 · verified]", "Allergy status: No known allergies; recorded 2026-10-14.", ["ALLERGIES"]],
  [{ sourceType: "OBSERVATION", day: at, rows: [{ at, hr: 112, sbp: 150, dbp: 94, spo2: 93, tempC: 38.4 }] },
    "[Vitals · 2026-10-14 · 2026-10-14 · verified]", "Vitals at 09:30 UTC: HR 112/min, BP 150/94 mmHg, SpO2 93%, temp 38.4 °C.", ["VITALS"]],
  [{ sourceType: "REFERRAL", reason: "Chest pain on exertion", to: "Cardiology", priority: "URGENT", status: "PLACED", at },
    "[Referral · Cardiology · 2026-10-14 · verified]", "Referral to Cardiology: Chest pain on exertion; urgent, placed; 2026-10-14.", ["REFERRALS"]],
  [{ sourceType: "GENERATED_DOCUMENT", docType: "prescription", title: "Prescription RX-1", patientVisible: true, at },
    "[Document · Prescription RX-1 · 2026-10-14 · verified]", "Prescription \"Prescription RX-1\" issued 2026-10-14.", ["PRESCRIPTIONS"]],
  [{ sourceType: "PATIENT_PROVIDED_RECORD", kind: "LAB_RESULT", value: { analyte: "Creatinine", value: "1.42", unit: "mg/dL", referenceRange: "0.70 - 1.30", flag: "H" }, at, handwritten: false, documentTitle: "Lab report" },
    "[Uploaded lab value · Creatinine · 2026-10-14 · patient-provided]", "Patient-reported lab value: Creatinine 1.42 mg/dL (reference 0.70 - 1.30), high (from the patient's document \"Lab report\"); dated 2026-10-14.", ["UPLOADS", "LABS"]],
  [{ sourceType: "PATIENT_PROVIDED_RECORD", kind: "MEDICATION_HISTORY", value: { form: "Tab.", name: "Amoxicilin", dose: "500 mg", frequency: "1-1-1", duration: "5 days" }, at, handwritten: true },
    "[Uploaded record · Amoxicilin · 2026-10-14 · patient-provided · handwritten]", "Patient-reported medicine: Tab. Amoxicilin 500 mg 1-1-1 for 5 days (from the patient's document); dated 2026-10-14; handwritten.", ["UPLOADS", "PRESCRIPTIONS"]],
  [{ sourceType: "PATIENT_DOCUMENT", docType: "REPORT", title: "Old CBC", at },
    "[Uploaded document · Old CBC · 2026-10-14 · patient-provided]", "Uploaded report \"Old CBC\", 2026-10-14; its contents are not confirmed yet.", ["UPLOADS"]],
];

describe("renderers (golden)", () => {
  it.each(GOLDEN.map((g) => [g[0].sourceType, g]))("%s", (_t, g) => {
    const [input, context, text, categories] = g as (typeof GOLDEN)[number];
    const r = renderSource(input);
    expect(r.context).toBe(context);
    expect(r.sections.map((s) => s.text).join("\n")).toBe(text);
    expect(r.categories).toEqual(categories);
  });
  it("notes keep their sections and are for the care team only", () => {
    const r = renderSource({ sourceType: "CLINICAL_NOTE", noteType: "PROGRESS", content: { subjective: "Cough for 3 days.", objective: { vitals: "T 38.4 °C" }, plan: ["CBC", "Chest X-ray"] }, at, amended: false });
    expect(r.sections).toEqual([{ heading: "Subjective", text: "Cough for 3 days." }, { heading: "Objective — Vitals", text: "T 38.4 °C" }, { heading: "Plan", text: "CBC\nChest X-ray" }]);
    expect(r.audience).toBe("STAFF_ONLY");
    expect(r.context).toBe("[Progress note · Progress note · 2026-10-14 · verified]");
  });
  it("imaging reports keep their sections; discharge summaries their JSON", () => {
    expect(renderSource({ sourceType: "IMAGING_REPORT", study: "X-Ray Chest PA", findings: "Opacity right lower zone.", impression: "Consolidation.", at, amended: false }).sections.map((s) => s.heading)).toEqual(["Findings", "Impression"]);
    expect(jsonSections({ course: "Uneventful", advice: ["Rest", "Fluids"] })).toEqual([{ heading: "Course", text: "Uneventful" }, { heading: "Advice", text: "Rest\nFluids" }]);
  });
  it("patient-provided entries are PERSON-origin; everything else verified; staff-only documents stay staff-only", () => {
    for (const [input] of GOLDEN) expect(renderSource(input).origin).toBe(input.sourceType.startsWith("PATIENT_") ? "PATIENT_PROVIDED" : "VERIFIED");
    expect(renderSource({ sourceType: "CLINICAL_DOCUMENT", docType: "consent", title: "x", patientVisible: false, at }).audience).toBe("STAFF_ONLY");
  });
  it("every source type renders to at least one category", () => {
    const covered = new Set([...GOLDEN.map((g) => g[0].sourceType), "CLINICAL_NOTE", "IMAGING_REPORT", "DISCHARGE_SUMMARY", "CLINICAL_DOCUMENT"]);
    expect([...covered].sort()).toEqual(Object.values($Enums.RagSourceType).sort());
    expect(renderSource({ sourceType: "DISCHARGE_SUMMARY", summary: {}, at }).categories).toEqual(["DISCHARGE_SUMMARIES"]);
  });
});

describe("sensitive categories (placeholder, pending clinical advisor)", () => {
  it("map codes and words, and err towards marking", () => {
    expect(sensitiveCategoryOf({ code: "F32.1" })).toBe("MENTAL_HEALTH");
    expect(sensitiveCategoryOf({ code: "F10.2" })).toBe("SUBSTANCE_USE");
    expect(sensitiveCategoryOf({ code: "B20" })).toBe("HIV");
    expect(sensitiveCategoryOf({ code: "A53.9" })).toBe("SEXUAL_HEALTH");
    expect(sensitiveCategoryOf({ code: "O24.4" })).toBe("REPRODUCTIVE_HEALTH");
    expect(sensitiveCategoryOf({ texts: ["HIV 1/2 antibody"] })).toBe("HIV");
    expect(sensitiveCategoryOf({ texts: ["Moderate depressive episode"] })).toBe("MENTAL_HEALTH");
    expect(sensitiveCategoryOf({ code: "E11.9", texts: ["Type 2 diabetes"] })).toBeNull();
    expect(renderSource({ sourceType: "LAB_RESULT", testName: "HIV 1/2 antibody", value: "Non-reactive", at, amended: false }).sensitiveCategory).toBe("HIV");
  });
});

describe("chunker", () => {
  it("never splits a sentence, a decimal or an abbreviation", () => {
    expect(sentences("Tab. Metformin 500 mg twice daily. Hb 11.2 g/dL today. Dr. Rao reviewed.")).toEqual(["Tab. Metformin 500 mg twice daily.", "Hb 11.2 g/dL today.", "Dr. Rao reviewed."]);
  });
  it("keeps a short section whole", () => {
    expect(chunkSections([{ heading: "Plan", text: "Repeat labs tomorrow." }])).toEqual([{ heading: "Plan", text: "Repeat labs tomorrow.", tokenCount: 6 }]);
  });
  it("splits a long section into chunks of at most 512 tokens with overlap", () => {
    const long = Array.from({ length: 120 }, (_, i) => `Day ${i}: the patient walked ${i * 10} metres with support and tolerated the full diet well.`).join("\n");
    const chunks = chunkSections([{ heading: "Course", text: long }]);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.tokenCount <= CHUNK.max && c.heading === "Course")).toBe(true);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1].text.split("\n"), cur = chunks[i].text.split("\n");
      const k = prev.length - prev.indexOf(cur[0]);
      // The next chunk opens with the previous chunk's last whole lines, at most 60 tokens of them.
      expect(prev.indexOf(cur[0])).toBeGreaterThan(0);
      expect(cur.slice(0, k)).toEqual(prev.slice(-k));
      expect(estimateTokens(cur.slice(0, k).join("\n"))).toBeLessThanOrEqual(CHUNK.overlap + k);
    }
    // Every line is in some chunk, whole.
    for (const line of long.split("\n")) expect(chunks.some((c) => c.text.split("\n").includes(line))).toBe(true);
    expect(estimateTokens("one two three")).toBe(4);
  });
});
