import { describe, expect, it } from "vitest";
import { getDocumentProviders } from "@/lib/ai/documents";
import { issuePermit } from "@/lib/ai/documents/permit";
import { FIXTURES } from "./fixtures";
import { meetsTargets, runEvaluation, TARGETS } from "./eval";
import { evaluationDictionary } from "./steps";

/**
 * Week 4a — the evaluation gate on the mock providers (CI): the set is the
 * one the design asks for, and the pipeline meets the targets on it.
 * Real-provider scoring is manual (npm run eval:documents -- --provider real).
 */
describe("document evaluation set", () => {
  it("50 synthetic samples, the app's eleven languages, 10 handwritten-style, every category", () => {
    expect(FIXTURES).toHaveLength(50);
    expect(new Set(FIXTURES.map((f) => f.id)).size).toBe(50);
    expect([...new Set(FIXTURES.map((f) => f.language))].sort()).toEqual(["bn", "en", "gu", "hi", "kn", "ml", "mr", "or", "ta", "te", "ur"]);
    expect(FIXTURES.filter((f) => f.handwritten)).toHaveLength(10);
    const by = (c: string) => FIXTURES.filter((f) => f.category === c).length;
    expect([by("LAB_REPORT"), by("PRESCRIPTION"), by("HANDWRITTEN_PRESCRIPTION"), by("DISCHARGE_SUMMARY"), by("IMAGING_REPORT"), by("MIXED")]).toEqual([15, 8, 10, 7, 5, 5]);
    expect(FIXTURES.filter((f) => f.handwritten).every((f) => f.misreads !== undefined)).toBe(true);
  });

  it("meets the targets on the mock providers", async () => {
    const r = await runEvaluation(getDocumentProviders({}), issuePermit("evaluation"), evaluationDictionary());
    const verdict = meetsTargets(r);
    expect(verdict.misses).toEqual([]);
    expect(r.exactness).toBe(TARGETS.exactness);
    expect(r.printed).toBeGreaterThanOrEqual(TARGETS.printed);
    expect(r.handwritten).toBeGreaterThanOrEqual(TARGETS.handwritten);
    // The planted misreads really cost accuracy: the handwritten score is a measurement, not a constant.
    expect(r.handwritten).toBeLessThan(1);
    // Every wrong fact the mocks produce is flagged LOW (misread lines have low OCR confidence).
    expect(r.calibration).toBe(1);
    expect(r.translationFailures).toBe(0);
    expect(r.translatedPages).toBe(50);
  }, 60_000);

  it("runs the rendered, normalized page images through the same steps (one sample per language)", async () => {
    const oneEach = [...new Map(FIXTURES.map((f) => [f.language, f])).values()];
    const r = await runEvaluation(getDocumentProviders({}), issuePermit("evaluation"), evaluationDictionary(), oneEach, "rendered-image");
    expect(r.samples).toHaveLength(11);
    expect(r.exactness).toBe(1);
    expect(r.printed).toBeGreaterThanOrEqual(TARGETS.printed);
    expect(r.translationFailures).toBe(0);
  }, 60_000);
});
