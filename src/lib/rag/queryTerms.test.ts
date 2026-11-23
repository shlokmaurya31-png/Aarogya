import { describe, expect, it } from "vitest";
import { ALL_FEATURES, queryTerms } from "./queryTerms";

/** RAG Phase 3, steps 3.5, 3.9, 3.10: what each keyword matcher is given. Development examples only. */
describe("queryTerms", () => {
  it("keeps the question's own words apart: the 'no record' rule counts only those", () => {
    const k = queryTerms("latest BP");
    expect(k.original).toEqual(["bp"]);
    expect(k.exact).toEqual(expect.arrayContaining(["bp", "blood", "pressure"]));
  });
  it("adds a medicine's other names (3.5)", () => expect(queryTerms("albuterol dose").exact).toContain("salbutamol"));
  it("gives the shadow matcher Latin skeletons and transliterates Latin words into the Indic scripts (3.9)", () => {
    const k = queryTerms("khaansi");
    expect(k.shadow).toContain("khansi");
    expect(k.trigramTranslit.some((w) => /\p{Script=Devanagari}/u.test(w))).toBe(true);
    expect(queryTerms("khaansi", { ...ALL_FEATURES, shadow: false }).shadow).toEqual([]);
  });
  it("puts the lexicon's other names in a separate expansion, never in the question's own words (3.10)", () => {
    const k = queryTerms("jaundice");
    expect(k.exact).toEqual(["jaundice"]);
    expect(k.expansion.exact).toContain("पीलिया");
    expect(queryTerms("jaundice", { ...ALL_FEATURES, lexicon: false }).expansion.exact).toEqual([]);
  });
  it("uses trigram for Indic words (inflection) and longer Latin words (typing errors), not short ones", () => {
    const k = queryTerms("खांसी hb hygene", { ...ALL_FEATURES, shadow: false });
    expect(k.trigramText).toEqual(["खांसी"]);
    expect(k.trigramLatin).toEqual(["hygene"]);
  });
});
