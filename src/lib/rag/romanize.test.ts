import { describe, expect, it } from "vitest";
import { latinSkeleton, romanizeText, romanizeWord, scriptOf, transliterateLatin } from "./romanize";

/**
 * RAG Phase 3, step 3.9 — the romanisation, per script, on the DEVELOPMENT
 * word list: cough, jaundice, diarrhoea, anaemia, vomiting, headache. The
 * Indic benchmark's words (eval/rag/indic) are the test set and are never
 * used here. Expected forms follow the scheme in romanize.ts; how people
 * actually type a word is what the trigram match tolerates.
 */
const DEV: [string, string, string][] = [
  // [word, the scheme's romanisation (skeleton), a typed Latin spelling whose skeleton is the same]
  ["खांसी", "khansi", "khaansi"],
  ["पीलिया", "piliya", "peeliya"],
  ["दस्त", "dast", "dast"],
  ["कमी", "kami", "kami"],
  ["उलटी", "ulati", "ulati"],
  ["কাশি", "kashi", "kaashi"],
  ["জন্ডিস", "jandis", "jandis"],
  ["இருமல்", "irumal", "irumal"],
  ["வாந்தி", "vanthi", "vaanthi"],
  ["దగ్గు", "dagu", "daggu"],
  ["తలనొప్పి", "talanopi", "talanoppi"],
  ["ಕೆಮ್ಮು", "kemu", "kemmu"],
  ["ತಲೆನೋವು", "talenovu", "talenovu"],
  ["ചുമ", "chuma", "chuma"],
  ["ഛർദ്ദി", "chardi", "chharddi"],
  ["ઉધરસ", "udharas", "udharas"],
  ["ઝાડા", "jhada", "jhaada"],
  ["କାଶ", "kasha", "kaasha"],
  ["ବାନ୍ତି", "banti", "baanti"],
  ["کھانسی", "khansi", "khansi"],
  ["الٹی", "alti", "alti"],
];

describe("romanisation (step 3.9)", () => {
  for (const [word, roman, typed] of DEV) {
    it(`${word} (${scriptOf([...word][0])}) → ${roman}; typed "${typed}" meets it`, () => {
      expect(romanizeText(word)).toBe(roman);
      expect(latinSkeleton(typed)).toBe(roman);
    });
  }
  it("leaves Latin words and numbers, and is null for text with no Indic letter", () => {
    expect(romanizeText("Paracetamol 500 mg")).toBeNull();
    expect(romanizeText("खांसी के लिए Paracetamol 500 mg")).toBe("khansi ke lie paraketamol 500 mg");
  });
  it("keeps the inherent vowel at the end where the language keeps it, and drops it where it doesn't", () => {
    expect(romanizeWord("कफ")).toBe("kaph");
    expect(romanizeWord("ಕಫ")).toBe("kapha");
  });
  it("reads digits in each script", () => expect(romanizeText("५०० ৫০০ ௫௦௦")).toBe("500 500 500"));
  it("folds vowel length and doubled letters in a typed word", () => {
    expect(latinSkeleton("Peeliyaa")).toBe("piliya");
    expect(latinSkeleton("cough")).toBe("kough");
  });
});

describe("Latin → Indic transliteration (query time)", () => {
  it("writes a Latin word in each Brahmic script, deterministically", () => {
    expect(transliterateLatin("dast", "Devanagari")).toBe("दस्त");
    expect(transliterateLatin("kami", "Devanagari")).toBe("कमि");
    expect(transliterateLatin("jhada", "Gujarati")).toBe("ઝદા");
    expect(transliterateLatin("chuma", "Malayalam")).toBe("ചുമ");
    expect(transliterateLatin("irumal", "Tamil")).toBe("இருமல்");
  });
  it("its romanisation comes back to the same skeleton (round trip) for each dev word's typed form", () => {
    for (const [, roman, typed] of DEV.filter(([w]) => scriptOf([...w][0]) !== "Arabic")) {
      const script = scriptOf([...DEV.find(([, r]) => r === roman)![0]][0]) as Exclude<NonNullable<ReturnType<typeof scriptOf>>, "Arabic">;
      expect(latinSkeleton(romanizeWord(transliterateLatin(typed, script))), `${typed} in ${script}`).toBe(latinSkeleton(typed));
    }
  });
});
