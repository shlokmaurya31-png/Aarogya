import { describe, expect, it } from "vitest";
import { nlemNames } from "@/lib/medicines/reference";
import { INN_STARTER } from "@/lib/medicines/innStarter";
import { MEDICINE_CLASSES, classesIn, classMembersIn, lineInClass } from "./medicineClasses";
import { MEDICINE_VARIANTS } from "./medicineNames";
import { routeQuestion } from "./router";
import { queryTerms } from "./queryTerms";
import { subjectCovered } from "./abstain";

/** RAG Phase 5, step 3c: the ATC classes and forms (invented questions and lines, and development questions; never a sealed one). */
const LANGS = ["en", "hi", "mr", "bn", "ta", "te", "kn", "ml", "gu", "or", "ur"] as const;

describe("the medicine classes", () => {
  it("each has an ATC code, names in all eleven languages and the review status", () => {
    for (const c of MEDICINE_CLASSES) {
      expect(c.atc, c.id).toMatch(/^[A-Z]\d{2}/);
      for (const l of LANGS) expect(c.names[l]?.length, `${c.id} ${l}`).toBeGreaterThan(0);
      expect(c.review).toBe("pending native-speaker and clinical review");
    }
  });
  it("maps every member to a WHO INN name the app already knows (NLEM 2022, the INN starter list or the variants table)", () => {
    const known = new Set([...nlemNames().map((n) => n.toLowerCase()), ...INN_STARTER, ...Object.keys(MEDICINE_VARIANTS)]);
    const unknown = [...new Set(MEDICINE_CLASSES.flatMap((c) => c.members))].filter((m) => !known.has(m));
    expect(unknown).toEqual([]);
  });
  it("finds a class by an English, an inflected Indic or a multi-word name", () => {
    expect(classesIn("Any statin?").map((c) => c.id)).toEqual(["STATINS"]);
    expect(classesIn("List her beta blockers").map((c) => c.id)).toContain("BETA_BLOCKERS");
    expect(classesIn("क्या स्टैटिनवाली दवा है").map((c) => c.id)).toContain("STATINS");
    expect(classesIn("Is she on metformin?")).toEqual([]);
    expect(classMembersIn("antibiotics given")).toContain("azithromycin");
  });
  it("puts a chart line in a class by its INN or its route", () => {
    const inhaler = MEDICINE_CLASSES.find((c) => c.id === "AIRWAY_INHALERS")!;
    expect(lineInClass("Active medicine: Salbutamol inhaler 100 mcg inhalation SOS (ordered 2026-11-20, active).", inhaler)).toBe(true);
    expect(lineInClass("Active medicine: Metformin 500 mg oral BD (ordered 2026-11-20, active).", inhaler)).toBe(false);
  });
});

describe("a class question", () => {
  it("routes to the medicines reader with the class as its entity", () => {
    const r = routeQuestion("List the antibiotics she gets", "CHART_QA");
    expect(r.kind === "PLAN" && r.plan.readers).toContain("MEDICINES");
    expect(r.kind === "PLAN" && r.plan.entities.medicineClass).toBe("ANTIBACTERIALS");
  });
  it("expands the search with the members' names and is covered by a member in the sources", () => {
    expect(queryTerms("Statin on board?").expansion.exact).toContain("atorvastatin");
    expect(subjectCovered("Statin on board?", ["Active medicine: Atorvastatin 10 mg oral HS."])).toBe(true);
    expect(subjectCovered("Beta blockers on board?", ["Active medicine: Atorvastatin 10 mg oral HS."])).toBe(false);
  });
});
