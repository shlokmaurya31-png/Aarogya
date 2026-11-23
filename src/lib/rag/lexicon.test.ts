import { describe, expect, it } from "vitest";
import { conceptsIn, LEXICON, LEXICON_REVIEW_STATUS, lexiconTerms } from "./lexicon";
import { ABBREVIATIONS, abbreviationTerms } from "./abbreviations";
import { canonicalMedicine, canonicalMedicinesIn, medicineTerms } from "./medicineNames";

/** RAG Phase 3, steps 3.5 and 3.10 — the tables. Examples are the development topics, not the Indic benchmark's. */
describe("the concept lexicon (3.10)", () => {
  it("every entry has a unique concept id, the review status, English and at least six other languages, and no dose", () => {
    expect(new Set(LEXICON.map((c) => c.id)).size).toBe(LEXICON.length);
    for (const c of LEXICON) {
      expect(c.review).toBe(LEXICON_REVIEW_STATUS);
      expect(c.names.en?.length).toBeGreaterThan(0);
      expect(Object.keys(c.names).length).toBeGreaterThanOrEqual(7);
      // No dose: no digit (in any script) and no unit.
      for (const n of Object.values(c.names).flat()) expect(n, `${c.id}: ${n}`).not.toMatch(/\p{N}|\b(mg|mcg|ml|g|iu|units?)\b/iu);
    }
  });
  it("covers conditions, symptoms, tests and medicines", () => {
    for (const k of ["CONDITION", "SYMPTOM", "TEST", "MEDICINE"]) expect(LEXICON.some((c) => c.kind === k)).toBe(true);
  });
  it("finds a concept by any of its names, an inflected Indic word included", () => {
    expect(conceptsIn("persistent cough").map((c) => c.id)).toEqual(["S_COUGH"]);
    expect(conceptsIn("खांसी के लिए").map((c) => c.id)).toEqual(["S_COUGH"]);
    expect(conceptsIn("ஜலதோஷம் இருமலுக்கு").map((c) => c.id)).toContain("S_COUGH");
    expect(conceptsIn("ঝাড়া").length).toBe(0);
  });
  it("finds a concept from a typed Latin spelling only with the romanised names (3.9 + 3.10)", () => {
    expect(conceptsIn("khansi").length).toBe(0);
    expect(conceptsIn("khansi", { romanized: true }).map((c) => c.id)).toContain("S_COUGH");
  });
  it("expands with the other names, in other scripts, never repeating a question word", () => {
    const t = lexiconTerms("jaundice");
    expect(t).toContain("पीलिया");
    expect(t).toContain("மஞ்சள்");
    expect(t).not.toContain("jaundice");
  });
  it("adds nothing for a question that names no concept", () => expect(lexiconTerms("visiting hours")).toEqual([]));
});

describe("abbreviations (3.5)", () => {
  it("expands an abbreviation to its long form, and a long form to its abbreviation", () => {
    expect(abbreviationTerms("latest BP")).toEqual(expect.arrayContaining(["blood", "pressure"]));
    expect(abbreviationTerms("blood pressure today")).toContain("bp");
    expect(abbreviationTerms("metformin 500 mg TDS")).toEqual(expect.arrayContaining(["three", "times", "daily"]));
  });
  it("only adds terms", () => expect(abbreviationTerms("hand hygiene")).toEqual([]));
  it("every abbreviation has a long form", () => { for (const v of Object.values(ABBREVIATIONS)) expect(v.length).toBeGreaterThan(0); });
});

describe("medicine names (3.5)", () => {
  it("maps a variant to the INN and expands a query both ways", () => {
    expect(canonicalMedicine("Albuterol")).toBe("salbutamol");
    expect(canonicalMedicinesIn("Albuterol inhaler and frusemide")).toEqual(["salbutamol", "furosemide"]);
    expect(medicineTerms(["acetaminophen"])).toContain("paracetamol");
    expect(medicineTerms(["paracetamol"])).toContain("acetaminophen");
  });
});
