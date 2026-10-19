import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { checkSentence, numbersIn, type SourceText } from "./validate";
import { patientSafety } from "./safety";
import { currentTextKey, decryptText, encryptText } from "./textCrypto";

/** Week 4b, RAG step 8: the sentence validator, the patient safety rules, text encryption. */
const src = (n: number, text: string, context = "[Lab result · Creatinine · 2026-10-14 · verified]"): [number, SourceText] => [n, { n, text, context }];
const sources = new Map([src(1, "Creatinine 1.42 mg/dL (reference 0.70 - 1.30), high, resulted 2026-10-14."), src(2, "Hemoglobin 11.2 g/dL, low.", "[Lab result · Hemoglobin · 2026-09-01 · verified]")]);

describe("sentence validation", () => {
  it("passes a cited sentence whose numbers are in its sources", () => {
    expect(checkSentence({ text: "Creatinine was 1.42 mg/dL on 2026-10-14, above 1.30.", citations: [1], kind: "FACT" }, sources)).toEqual({ ok: true });
    expect(checkSentence({ text: "Hb 11.2 and creatinine 1.42.", citations: [1, 2], kind: "FACT" }, sources)).toEqual({ ok: true });
  });
  it("refuses a fact with no citation, or citing a source not retrieved", () => {
    expect(checkSentence({ text: "Creatinine is high.", citations: [], kind: "FACT" }, sources)).toEqual({ ok: false, reason: "NO_CITATION" });
    expect(checkSentence({ text: "Creatinine is high.", citations: [7], kind: "FACT" }, sources)).toEqual({ ok: false, reason: "UNKNOWN_CITATION" });
  });
  it("refuses a number not in the cited sources (a rounded, invented or misattributed value)", () => {
    expect(checkSentence({ text: "Creatinine was 1.4 mg/dL.", citations: [1], kind: "FACT" }, sources)).toEqual({ ok: false, reason: "NUMBER_NOT_IN_SOURCE" });
    expect(checkSentence({ text: "Hemoglobin was 11.2 g/dL.", citations: [1], kind: "FACT" }, sources)).toEqual({ ok: false, reason: "NUMBER_NOT_IN_SOURCE" });
  });
  it("allows guidance only without citations or numbers (112 excepted)", () => {
    expect(checkSentence({ text: "Please ask your care team.", citations: [], kind: "GUIDANCE" }, sources)).toEqual({ ok: true });
    expect(checkSentence({ text: "Call 112 now.", citations: [], kind: "GUIDANCE" }, sources)).toEqual({ ok: true });
    expect(checkSentence({ text: "Take 2 tablets.", citations: [], kind: "GUIDANCE" }, sources).ok).toBe(false);
    expect(checkSentence({ text: "Ask about it.", citations: [1], kind: "GUIDANCE" }, sources).ok).toBe(false);
  });
  it("normalizes numbers as written", () => {
    expect(numbersIn("1,000 cells; 07/03/2026; 0.70 - 1.30")).toEqual(["1000", "7", "3", "2026", "0.70", "1.30"]);
  });
});

describe("patient safety rules (pending clinical advisor)", () => {
  it("send urgent symptoms to emergency care", () => {
    for (const q of ["I have chest pain right now", "My father fainted", "I want to end my life", "सीने में दर्द हो रहा है"]) expect(patientSafety(q), q).toBe("URGENT");
  });
  it("refuse diagnosis and treatment questions", () => {
    for (const q of ["Do I have diabetes?", "Is this cancer?", "What is wrong with me?"]) expect(patientSafety(q), q).toBe("DIAGNOSIS");
    for (const q of ["Should I stop metformin?", "Can I take two tablets?", "How much should I take?", "Is it safe to take ibuprofen?"]) expect(patientSafety(q), q).toBe("TREATMENT");
  });
  it("let a question about the report through", () => {
    for (const q of ["What does TSH mean in my report?", "Which values are marked high?", undefined]) expect(patientSafety(q)).toBe("OK");
  });
});

describe("retained text encryption", () => {
  const env = { AI_TEXT_KEY_VERSION: "2", AI_TEXT_KEY_1: randomBytes(32).toString("base64"), AI_TEXT_KEY_2: randomBytes(32).toString("base64") };
  it("round-trips with the current key; old rows decrypt with their own version", () => {
    const k = currentTextKey(env)!;
    expect(k.version).toBe(2);
    const c = encryptText("What was the patient's creatinine?", k.key);
    expect(c).not.toContain("creatinine");
    expect(decryptText(c, 2, env)).toBe("What was the patient's creatinine?");
    const old = encryptText("older", currentTextKey({ ...env, AI_TEXT_KEY_VERSION: "1" })!.key);
    expect(decryptText(old, 1, env)).toBe("older");
  });
  it("detects tampering, and keeps nothing without a key", () => {
    const k = currentTextKey(env)!;
    const c = Buffer.from(encryptText("x", k.key), "base64");
    c[c.length - 1] ^= 1;
    expect(() => decryptText(c.toString("base64"), 2, env)).toThrow();
    expect(currentTextKey({})).toBeNull();
    expect(currentTextKey({ AI_TEXT_KEY_1: Buffer.from("short").toString("base64") })).toBeNull();
  });
});
