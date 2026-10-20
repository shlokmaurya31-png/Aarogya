import { describe, expect, it } from "vitest";
import { DEFAULT_SHARE_CATEGORIES, LEGACY_CODE_CATEGORIES, PROVIDED_KIND_CATEGORY, SHARE_CATEGORIES, parseShareChoice, ragCategoriesFor } from "./categories";
import { DEFAULT_SHARE_CHOICE } from "@/components/patient-portal/ShareChoices";

describe("share categories (4c fix)", () => {
  it("defaults to every non-sensitive category, uploads included, clinical notes left out", () => {
    expect([...DEFAULT_SHARE_CATEGORIES].sort()).toEqual(SHARE_CATEGORIES.filter((c) => c !== "CLINICAL_NOTES").sort());
    expect(DEFAULT_SHARE_CATEGORIES).toContain("UPLOADS");
    expect(DEFAULT_SHARE_CATEGORIES).toContain("CONDITIONS");
    expect(DEFAULT_SHARE_CATEGORIES).toContain("VITALS");
    expect(DEFAULT_SHARE_CATEGORIES).not.toContain("CLINICAL_NOTES");
  });

  it("the share screen pre-selects exactly the server default", () => {
    expect([...DEFAULT_SHARE_CHOICE].sort()).toEqual([...DEFAULT_SHARE_CATEGORIES].sort());
  });

  it("a body that names no categories gets the default; sensitive stays empty", () => {
    const c = parseShareChoice({}, { categories: DEFAULT_SHARE_CATEGORIES });
    expect(c.categories.sort()).toEqual([...DEFAULT_SHARE_CATEGORIES].sort());
    expect(c.sensitiveCategories).toEqual([]);
  });

  it("the patient can untick anything but must keep one", () => {
    expect(parseShareChoice({ categories: ["LABS"] }).categories).toEqual(["LABS"]);
    expect(() => parseShareChoice({ categories: [] })).toThrow(/at least one/);
  });

  it("pre-4c codes keep the narrow legacy scope", () => {
    expect([...LEGACY_CODE_CATEGORIES].sort()).toEqual(["DISCHARGE_SUMMARIES", "IMAGING", "LABS", "PRESCRIPTIONS"]);
  });

  it("maps to retrieval categories, always with allergies", () => {
    expect(ragCategoriesFor(["CONDITIONS"]).sort()).toEqual(["ALLERGIES", "DIAGNOSES"]);
    expect(ragCategoriesFor(["VITALS", "CLINICAL_NOTES"]).sort()).toEqual(["ALLERGIES", "CLINICAL_NOTES", "VITALS"]);
    expect(ragCategoriesFor(["UPLOADS"])).toContain("UPLOADS");
  });

  it("patient-provided conditions need CONDITIONS (and UPLOADS)", () => {
    expect(PROVIDED_KIND_CATEGORY.DIAGNOSIS).toBe("CONDITIONS");
    expect(PROVIDED_KIND_CATEGORY.ALLERGY).toBe("ALWAYS");
  });
});
