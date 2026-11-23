import { describe, expect, it } from "vitest";
import { dedupePassages, dropCoveredByFacts } from "./context";

/** RAG Phase 3, step 3.7: structured facts first; passages deduplicated. */
describe("context building", () => {
  it("keeps the better-ranked of two passages with the same normalised text", () => {
    const out = dedupePassages([{ id: "a", text: "Hemoglobin 11.2 g/dL." }, { id: "b", text: "Other." }, { id: "c", text: "  hemoglobin   11.2 G/DL. " }]);
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });
  it("never merges passages that differ in a number", () => {
    expect(dedupePassages([{ text: "Potassium 5.6 mEq/L." }, { text: "Potassium 5.5 mEq/L." }])).toHaveLength(2);
  });
  it("drops a passage about the same row as a reader's fact, and only that one", () => {
    const chunks = [{ sourceType: "LAB_RESULT", sourceId: "r1" }, { sourceType: "LAB_RESULT", sourceId: "r2" }, { sourceType: "DIAGNOSIS", sourceId: "r1" }];
    expect(dropCoveredByFacts(chunks, [{ sourceType: "LAB_RESULT", sourceId: "r1" }])).toEqual([{ sourceType: "LAB_RESULT", sourceId: "r2" }, { sourceType: "DIAGNOSIS", sourceId: "r1" }]);
  });
});
