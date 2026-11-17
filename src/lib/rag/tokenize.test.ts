import { describe, expect, it } from "vitest";
import { orTsQuery } from "./search";
import { contentWords } from "@/lib/ai/record/mock";

/** RAG Phase 1 fix: a word in any of the app's scripts stays one word (vowel signs, viramas and zero-width joiners included). */
const WORDS: [string, string][] = [
  ["hi", "मधुमेह"], ["mr", "मधुमेहासाठी"], ["bn", "ডায়াবেটিসের"], ["gu", "ડાયાબિટીસની"], ["te", "మెట్‌ఫార్మిన్"],
  ["ta", "நீரிழிவுக்கு"], ["kn", "ಮೆಟ್‌ಫಾರ್ಮಿನ್"], ["ml", "പ്രമേഹത്തിന്"], ["or", "ମଧୁମେହର"], ["ur", "ذیابیطس"], ["en", "metformin"],
];

describe("query words in all eleven languages", () => {
  it.each(WORDS)("%s: %s stays one word", (_lang, word) => {
    expect(contentWords(`${word} 500 mg`)).toEqual([word.normalize("NFKC"), "500", "mg"]);
    expect(orTsQuery([word])).toBe(word.normalize("NFKC"));
  });
  it("still drops punctuation and keeps English stemming", () => {
    expect(orTsQuery(["allergic,", "(BP)"])).toBe("allerg:* | bp");
  });
});
