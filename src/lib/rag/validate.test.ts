import { describe, expect, it } from "vitest";
import { checkSentence, medicinesIn, unitsIn, type SourceText } from "./validate";

/** RAG Phase 5, step 5.5 — medicine names and units join the validation. */
const src = (text: string, context = "[Active medicine · Metformin · 2026-11-20 · verified]"): Map<number, SourceText> => new Map([[1, { n: 1, text, context }]]);
const fact = (text: string) => ({ text, citations: [1], kind: "FACT" as const });
const MED = src("Active medicine: Metformin 500 mg oral BD (ordered 2026-11-20, active).");
const LAB = src("Hemoglobin 11.2 g/dL (reference 12.0 - 15.5), low.", "[Lab result · Hemoglobin · 2026-10-01 · verified]");

describe("units", () => {
  it("reads a number's unit, normalising spellings", () => {
    expect(unitsIn("Metformin 500 mg BD; Hb 11.2 g/dL; salbutamol 100 µg; 2 puffs")).toEqual([["500", "mg"], ["11.2", "g/dl"], ["100", "mcg"], ["2", "puffs"]]);
  });
  it("passes the source's own unit, fails a swapped one", () => {
    expect(checkSentence(fact("Hemoglobin 11.2 g/dL, low."), LAB)).toEqual({ ok: true });
    expect(checkSentence(fact("Hemoglobin 11.2 mg/dL, low."), LAB)).toEqual({ ok: false, reason: "UNIT_NOT_IN_SOURCE" });
    expect(checkSentence(fact("Metformin 500 mcg twice a day."), MED)).toEqual({ ok: false, reason: "UNIT_NOT_IN_SOURCE" });
    expect(checkSentence(fact("Metformin 500 g twice a day."), MED)).toEqual({ ok: false, reason: "UNIT_NOT_IN_SOURCE" });
  });
  it("allows the source's unit on a number it writes bare (a reference range's end)", () => {
    expect(checkSentence(fact("The reference range is 12.0 - 15.5 g/dL."), LAB)).toEqual({ ok: true });
    expect(checkSentence(fact("The reference range is 12.0 - 15.5 mmol/L."), LAB)).toEqual({ ok: false, reason: "UNIT_NOT_IN_SOURCE" });
  });
});

describe("medicine names", () => {
  it("finds medicines by INN, variant and Indic name, as one concept", () => {
    expect([...medicinesIn("Salbutamol and albuterol")]).toEqual(["salbutamol"]);
    expect(medicinesIn("मेटफॉर्मिन 500 mg").has("metformin")).toBe(true);
  });
  it("passes the source's medicine (or its other name), fails a renamed one with the same dose", () => {
    expect(checkSentence(fact("Metformin 500 mg oral BD."), MED)).toEqual({ ok: true });
    expect(checkSentence(fact("मेटफॉर्मिन 500 mg"), MED)).toEqual({ ok: true });
    expect(checkSentence(fact("Glimepiride 500 mg oral BD."), MED)).toEqual({ ok: false, reason: "MEDICINE_NOT_IN_SOURCE" });
    expect(checkSentence(fact("Metformin 500 mg, with atorvastatin."), MED)).toEqual({ ok: false, reason: "MEDICINE_NOT_IN_SOURCE" });
  });
  it("doesn't count an analyte or a vital as a medicine", () => {
    expect(checkSentence(fact("Oxygen saturation 91%."), src("SpO2 91%, HR 112/min.", "[Vitals · 2026-11-20 · verified]"))).toEqual({ ok: true });
    expect(checkSentence(fact("Serum potassium 5.6 mEq/L."), src("Potassium 5.6 mEq/L (reference 3.5 - 5.1), high.", "[Lab result · Potassium · 2026-10-01 · verified]"))).toEqual({ ok: true });
  });
  it("still fails a wrong dose on the number", () => {
    expect(checkSentence(fact("Metformin 1000 mg oral BD."), MED)).toEqual({ ok: false, reason: "NUMBER_NOT_IN_SOURCE" });
  });
});
