import { describe, expect, it } from "vitest";
import type { CandidateFact, Line } from "@/lib/ai/documents/types";
import { assessCandidates, exactCopyHolds, maskIdentifierLines } from "./assess";
import { identifierSpans } from "./identifiers";

const L = (text: string, confidence = 0.97): Line => ({ text, confidence, bbox: [0.1, 0.1, 0.8, 0.05] });
const page = (lines: Line[], handwritten = false) => ({ pageNo: 1, text: lines.map((l) => l.text).join("\n"), layout: lines, handwritten, confidence: 0.95 });
const lab = (value: Record<string, unknown>, sourceText = "Hemoglobin 11.2 g/dL (12.0 - 15.5) L"): CandidateFact => ({ factType: "LAB_VALUE", value, sourceText, lines: [0] });
const HB = { analyte: "Hemoglobin", value: "11.2", numericValue: 11.2, unit: "g/dL", referenceRange: "12.0 - 15.5", flag: "L" };

describe("assessCandidates", () => {
  it("a verbatim printed fact passes, HIGH, with its region", () => {
    const { facts } = assessCandidates(page([L("Hemoglobin 11.2 g/dL (12.0 - 15.5) L")]), [lab(HB)]);
    expect(facts[0]).toMatchObject({ exactCopyCheck: "PASSED", confidenceBand: "HIGH", region: [0.1, 0.1, 0.8, 0.05] });
  });
  it("a reformatted value (rounded, unit changed) fails exact copy and is LOW", () => {
    const p = page([L("Hemoglobin 11.2 g/dL (12.0 - 15.5) L")]);
    expect(assessCandidates(p, [lab({ ...HB, value: "11", numericValue: 11 })]).facts[0]).toMatchObject({ exactCopyCheck: "FAILED", confidenceBand: "LOW" });
    expect(assessCandidates(p, [lab({ ...HB, unit: "gm/dl" })]).facts[0].exactCopyCheck).toBe("FAILED");
    expect(assessCandidates(p, [lab({ ...HB, numericValue: 11.25 })]).facts[0].exactCopyCheck).toBe("FAILED");
  });
  it("a sourceText that isn't on the page fails, whatever the fields say", () => {
    expect(assessCandidates(page([L("Hemoglobin 11.2 g/dL")]), [lab({ analyte: "Hemoglobin", value: "11.2", unit: "g/dL" }, "Hemoglobin 11.2 g/dL (normal)")]).facts[0].exactCopyCheck).toBe("FAILED");
  });
  it("whitespace is the only normalization", () => {
    expect(exactCopyHolds("LAB_VALUE", { analyte: "Hemoglobin", value: "11.2", unit: "g/dL" }, "Hemoglobin  11.2 g/dL", "Hemoglobin 11.2\tg/dL")).toBe(true);
    expect(exactCopyHolds("LAB_VALUE", { analyte: "hemoglobin", value: "11.2", unit: "g/dL" }, "Hemoglobin 11.2 g/dL", "Hemoglobin 11.2 g/dL")).toBe(false);
  });
  it("handwritten: at most MEDIUM; low line confidence: LOW", () => {
    expect(assessCandidates(page([L("Hemoglobin 11.2 g/dL (12.0 - 15.5) L", 0.97)], true), [lab(HB)]).facts[0]).toMatchObject({ confidenceBand: "MEDIUM", handwritten: true });
    expect(assessCandidates(page([L("Hemoglobin 11.2 g/dL (12.0 - 15.5) L", 0.6)]), [lab(HB)]).facts[0].confidenceBand).toBe("LOW");
  });
  it("an incomplete medication is one band lower; a schema-invalid candidate is dropped", () => {
    const p = page([L("Tab. Metformin 500 mg")]);
    const noFreq: CandidateFact = { factType: "MEDICATION", value: { name: "Metformin", dose: "500 mg" }, sourceText: "Tab. Metformin 500 mg", lines: [0] };
    expect(assessCandidates(p, [noFreq]).facts[0]).toMatchObject({ confidenceBand: "MEDIUM", exactCopyCheck: "PASSED" });
    const r = assessCandidates(p, [{ ...noFreq, value: { dose: "500 mg" } }, { ...noFreq, value: { name: "Metformin", colour: "white" } }]);
    expect(r.facts).toHaveLength(0);
    expect(r.dropped).toBe(2);
    const unitless = assessCandidates(page([L("ESR 28")]), [{ factType: "LAB_VALUE", value: { analyte: "ESR", value: "28", unit: "mm/hr" }, sourceText: "ESR 28", lines: [0] }]);
    expect(unitless.facts[0].exactCopyCheck).toBe("FAILED");
  });
  it("second-pass disagreement on an exact field forces LOW; agreement keeps the band", () => {
    const p = page([L("Hemoglobin 11.2 g/dL (12.0 - 15.5) L")]);
    expect(assessCandidates(p, [lab(HB)], [lab(HB)]).facts[0].confidenceBand).toBe("HIGH");
    expect(assessCandidates(p, [lab(HB)], [lab({ ...HB, value: "11.7" })]).facts[0].confidenceBand).toBe("LOW");
    expect(assessCandidates(p, [lab(HB)], []).facts[0].confidenceBand).toBe("LOW");
  });
  it("lines fall back to those containing the source text", () => {
    const { facts } = assessCandidates(page([L("Header"), L("Hemoglobin 11.2 g/dL (12.0 - 15.5) L", 0.8)]), [{ ...lab(HB), lines: [99] }]);
    expect(facts[0].confidence).toBe(0.8);
  });
});

describe("identifier masking for the extractor", () => {
  it("masks names and ids consistently and restores them in values", () => {
    const m = maskIdentifierLines(["Patient: Asha Verma", "Dr. Rao saw ASHA VERMA"], (t) => identifierSpans(t, ["Asha Verma"]));
    expect(m.masked).toEqual(["Patient: ⟦I1⟧", "Dr. Rao saw ⟦I2⟧"]);
    expect(m.restoreDeep({ a: ["⟦I1⟧", { b: "x ⟦I2⟧" }] })).toEqual({ a: ["Asha Verma", { b: "x ASHA VERMA" }] });
  });
});

describe("occursAsToken", () => {
  it("whole tokens only", async () => {
    const { occursAsToken } = await import("./assess");
    expect(occursAsToken("Hemoglobin 11.2 g/dL", "11.2")).toBe(true);
    expect(occursAsToken("Hemoglobin 11.2 g/dL", "11")).toBe(false);
    expect(occursAsToken("Hemoglobin 11.2 g/dL", "1.2")).toBe(false);
    expect(occursAsToken("Hemoglobin 11.2 g/dL", "g/dL")).toBe(true);
    expect(occursAsToken("Hemoglobin 11.2 g/dL", "g")).toBe(false);
    expect(occursAsToken("Tab. Metformin 500 mg 1-0-1 x 30 days", "500 mg")).toBe(true);
    expect(occursAsToken("Tab. Metformin 500 mg 1-0-1", "1-0-1")).toBe(true);
    expect(occursAsToken("Tab. Metformin 500 mg", "Metform")).toBe(false);
    expect(occursAsToken("WBC 7800 /cumm (4000 - 11000)", "4000 - 11000")).toBe(true);
    expect(occursAsToken("Range (12.0 - 15.5)", "15")).toBe(false);
    expect(occursAsToken("Platelet Count 2.45 x10^3/µL", "x10^3/µL")).toBe(true);
  });
});
