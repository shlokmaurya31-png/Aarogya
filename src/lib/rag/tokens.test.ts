import { afterEach, describe, expect, it } from "vitest";
import { baseTokens, calibrate, countTokens, dominantScript, familyFor, setCalibration } from "./tokens";
import { TOKEN_REFERENCE } from "./tokenReference";
import { estimateTokens } from "./chunk";

/** RAG Phase 4, step 4.3: calibrated on half the reference texts, the estimate is within 15% of the reference on the other half, per language. */
describe("token estimation", () => {
  afterEach(() => setCalibration("anthropic", null));

  it("is within 15% of the reference for each of the eleven languages after calibration", () => {
    const train = Object.values(TOKEN_REFERENCE).flatMap((xs) => xs.filter((_, i) => i % 2 === 0).map(([text, reported]) => ({ text, reported })));
    setCalibration("anthropic", calibrate(train, "anthropic"));
    expect(Object.keys(TOKEN_REFERENCE)).toHaveLength(11);
    for (const [lang, xs] of Object.entries(TOKEN_REFERENCE)) {
      const held = xs.filter((_, i) => i % 2 === 1);
      const est = held.reduce((a, [t]) => a + countTokens(t, "anthropic"), 0);
      const ref = held.reduce((a, [, n]) => a + n, 0);
      expect(Math.abs(est - ref) / ref, lang).toBeLessThanOrEqual(0.15);
    }
  });

  it("counts Indic text as more tokens than the old quarter-of-the-characters estimate", () => {
    for (const lang of ["hi", "ta", "ml", "or"]) {
      const [text] = TOKEN_REFERENCE[lang][0];
      expect(baseTokens(text, "anthropic")).toBeGreaterThan(estimateTokens(text));
    }
  });

  it("each provider family counts on its own scale", () => {
    const t = "Hemoglobin 11.2 g/dL (reference 12.0 - 15.5), low";
    expect(baseTokens(t, "anthropic")).not.toBe(baseTokens(t, "voyage"));
    expect(familyFor("claude")).toBe("anthropic");
    expect(familyFor("voyage-multilingual-2")).toBe("voyage");
    expect(familyFor("mock-hash")).toBe("mock-hash");
  });

  it("names the dominant script, ignoring digits and spaces", () => {
    expect(dominantScript("हीमोग्लोबिन 11.2 g/dL")).toBe("devanagari");
    expect(dominantScript("ٹائیفائیڈ کے مریض")).toBe("arabic");
    expect(dominantScript("SpO2 91%")).toBe("latin");
  });
});
