import { describe, it, expect } from "vitest";
import { protectedSpans, mask, restore, placeholdersIntact, noInventedNumbers, ExactCopyViolation } from "./protect";
import { expandEntry, nlemNames } from "@/lib/medicines/reference";
import { NLEM_2022 } from "@/lib/medicines/nlem2022";

const DICT = ["Metformin", "Paracetamol", "Amlodipine", "Telmisartan", "Atorvastatin"];
const texts = (s: string, spans = protectedSpans(s, DICT)) => spans.map((x) => s.slice(x.start, x.end));

describe("protected spans", () => {
  it("finds lab values with units and ranges", () => {
    expect(texts("Hemoglobin 13.2 g/dL (12.0-16.0)")).toEqual(["Hemoglobin", "13.2", "g/dL", "12.0-16.0"]);
  });
  it("finds medicine, strength, dose notation and duration", () => {
    expect(texts("Tab Metformin 500 mg 1-0-1 x 30 days")).toEqual(["Metformin", "500", "mg", "1-0-1", "x 30 days"]);
  });
  it("finds blood pressure as one value and abbreviations", () => {
    expect(texts("BP 140/90 mmHg, Amlodipine 5 mg OD")).toEqual(["140/90", "mmHg", "Amlodipine", "5", "mg", "OD"]);
  });
  it("works inside Indic-script text", () => {
    expect(texts("मरीज़ को Paracetamol 650 mg दिन में तीन बार")).toEqual(["Paracetamol", "650", "mg"]);
    expect(texts("ரத்த சர்க்கரை 182 mg/dL")).toEqual(["182", "mg/dL"]);
  });
  it("tagged spans only add protection", () => {
    const s = "Tab Glycomet 500 mg";
    const tagged = protectedSpans(s, DICT, [{ start: 4, end: 12, kind: "TAGGED" }]);
    expect(texts(s, tagged)).toEqual(["Glycomet", "500", "mg"]);
    expect(texts(s)).toEqual(["500", "mg"]);
  });
});

describe("mask and restore", () => {
  it("round-trips every text exactly (property: random texts with planted values)", () => {
    const words = ["Tab", "Metformin", "500", "mg", "दिन", "BD", "x 5 days", "12.5", "Hemoglobin", "g/dL", "120/80", "और", "நாள்", "Telmisartan", "40"];
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 300; i++) {
      const text = Array.from({ length: 4 + Math.floor(rand() * 10) }, () => words[Math.floor(rand() * words.length)]).join(" ");
      const m = mask(text, protectedSpans(text, DICT));
      expect(m.masked.replace(/⟦P\d+⟧/g, "")).not.toMatch(/\d/);
      expect(restore(m.masked, m.originals)).toBe(text);
    }
  });
  it("refuses a translation that drops, duplicates or invents a placeholder", () => {
    const m = mask("Metformin 500 mg BD", protectedSpans("Metformin 500 mg BD", DICT));
    const n = m.originals.length;
    expect(placeholdersIntact(m.masked, n)).toBe(true);
    expect(() => restore(m.masked.replace("⟦P2⟧", ""), m.originals)).toThrow(ExactCopyViolation);
    expect(() => restore(m.masked + " ⟦P2⟧", m.originals)).toThrow(ExactCopyViolation);
    expect(() => restore(m.masked + ` ⟦P${n + 1}⟧`, m.originals)).toThrow(ExactCopyViolation);
  });
});

describe("a translator can't invent a number", () => {
  it("refuses any digit outside a placeholder, in any script", () => {
    expect(noInventedNumbers("⟦P1⟧ गोली ⟦P2⟧ ⟦P3⟧")).toBe(true);
    expect(noInventedNumbers("⟦P1⟧ गोली 2 बार")).toBe(false);
    expect(noInventedNumbers("⟦P1⟧ गोली २ बार")).toBe(false);
    expect(noInventedNumbers("⟦P1⟧ ௨ முறை")).toBe(false);
  });
});

describe("NLEM 2022 reference names", () => {
  it("has the 379 generic names and no NLEM section headings", () => {
    expect(NLEM_2022.length).toBe(379);
    for (const n of NLEM_2022) expect(n).not.toMatch(/^(Medicines (used|for|acting|affecting)|Anti-infective Medicines|Vitamins and Minerals|Solutions correcting)/);
  });
  it("expands combinations and alternatives", () => {
    expect(expandEntry("Amoxicillin (A) + Clavulanic acid (B)").sort()).toEqual(["Amoxicillin", "Amoxicillin + Clavulanic acid", "Clavulanic acid"].sort());
    expect(expandEntry("5-aminosalicylic acid (Mesalazine/Mesalaine)").sort()).toEqual(["5-aminosalicylic acid", "Mesalaine", "Mesalazine"].sort());
    expect(nlemNames()).toContain("Metformin");
  });
});

describe("letter-digit codes", () => {
  it("L4-L5, (Vitamin) B12, T2DM and 2nd are protected whole, so no digit is left for a translator", () => {
    const text = "निष्कर्ष: L4-L5 disc bulge, Vitamin B12 low, T2DM since 2nd visit";
    const m = mask(text, protectedSpans(text, []));
    expect(m.originals).toEqual(["L4-L5", "Vitamin B12", "T2DM", "2nd"]);
    expect(noInventedNumbers(m.masked)).toBe(true);
  });
});

