import { describe, expect, it } from "vitest";
import { salientTerms, subjectCovered } from "./abstain";
import { routeQuestion } from "./router";

/** RAG Phase 5, step 3b: the subject of an English question must be in its evidence. */
const DIAGNOSES = ["[Diagnosis · Community acquired pneumonia · 2026-10-01 · verified]\nDiagnosis: Community acquired pneumonia (J18.9), final, status resolved."];
const XRAY = ["[Imaging report · X-ray Chest PA view · 2026-10-01 · verified]\nFindings: Homogeneous opacity in the right lower zone. Impression: Findings suggest right lower zone consolidation."];

describe("subjectCovered", () => {
  it("is false for the Phase 4 false answers: the subject is nowhere in the evidence", () => {
    expect(subjectCovered("HIV status?", DIAGNOSES)).toBe(false);
    expect(subjectCovered("Last ECG findings?", XRAY)).toBe(false);
    expect(subjectCovered("Hepatitis C serology?", [...DIAGNOSES, ...XRAY])).toBe(false);
  });
  it("is true when a salient word, or another name for it, is in the evidence", () => {
    expect(subjectCovered("What did the CXR show?", XRAY)).toBe(true);
    expect(subjectCovered("What did the chest film show?", XRAY)).toBe(true);
    expect(subjectCovered("Has she had pneumonia?", DIAGNOSES)).toBe(true);
    expect(subjectCovered("Is she on albuterol?", ["Active medicine: Salbutamol inhaler 100 mcg inhalation SOS."])).toBe(true);
    expect(subjectCovered("Anaemia tablets?", ["రక్తహీనత ఉన్నవారికి ఐరన్ మాత్రలు ఇవ్వండి."])).toBe(true);
  });
  it("doesn't apply without a salient Latin word (an Indic question, or only generic words)", () => {
    expect(subjectCovered("मरीज़ का ब्लड ग्रुप क्या है?", DIAGNOSES)).toBeNull();
    expect(subjectCovered("Latest results?", DIAGNOSES)).toBeNull();
    expect(salientTerms("What is the status of the latest report?")).toEqual([]);
  });
});

describe("supply questions route as operational", () => {
  it("never to a patient reader, though they name a vital or a medicine", () => {
    for (const q of ["How many oxygen cylinders are in stock?", "Is ceftriaxone in stock?", "Are any ventilators free?"]) {
      const r = routeQuestion(q, "CHART_QA", { medicines: new Set(["ceftriaxone"]) });
      expect(r.kind === "PLAN" && r.plan.intent, q).toBe("OPERATIONAL");
    }
    const sats = routeQuestion("Oxygen saturation now?", "CHART_QA");
    expect(sats.kind === "PLAN" && sats.plan.readers).toEqual(["VITALS"]);
  });
});

describe("synonyms (step 3d)", () => {
  it("count the record's word as the subject", () => {
    const crit = ["[Lab result · Troponin I · 2026-10-02 · verified]\nTroponin I 2.4 ng/mL (reference 0.00 - 0.04), high, critical value."];
    expect(subjectCovered("Any panic values?", crit)).toBe(true);
    expect(subjectCovered("Any panic values?", XRAY)).toBe(false);
    expect(subjectCovered("Any scan reports?", ["[Imaging report · X-ray Chest PA view · 2026-10-01 · verified]\nImpression: consolidation."])).toBe(true);
  });
});
