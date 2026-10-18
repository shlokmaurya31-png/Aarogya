import { describe, expect, it } from "vitest";
import { detectLanguage } from "./language";
import { identifierSpans } from "./identifiers";
import { FIXTURES } from "./fixtures";
import { ocrLines } from "./fixtures/build";
import { protectedSpans } from "./protect";
import { LABELS, SUPPORTED_LANGUAGES } from "./vocab";
import { bandOf, capBand, lowerBand } from "./confidence";

const strip = (t: string) => { let out = "", at = 0; for (const s of protectedSpans(t, ["Metformin", "Paracetamol"])) { out += t.slice(at, s.start) + " "; at = s.end; } return out + t.slice(at); };

describe("language detection", () => {
  it("each fixture's page is detected as its language (mixed pages as mixed)", () => {
    for (const f of FIXTURES) {
      const d = detectLanguage(ocrLines(f, 1).map((l) => strip(l.text)));
      expect(d.language, f.id).toBe(f.mixed ? "mixed" : f.language);
    }
  });
  it("every supported language's labels and advice are detected as that language", () => {
    for (const l of SUPPORTED_LANGUAGES) {
      const lines = [`${LABELS[l].diagnosis}: x`, `${LABELS[l].advice}: ${LABELS[l].adviceText}`, `${LABELS[l].patient}: y`];
      expect(detectLanguage(lines).language, l).toBe(l);
    }
  });
  it("Odia (Orya) and Urdu (Arabic script, right to left) are detected, values in English notwithstanding", () => {
    const or = detectLanguage([strip("ରୋଗୀ: Sasmita Behera"), strip("TSH 3.1 µIU/mL (0.4 - 4.0)"), strip("ଔଷଧ ସମୟରେ ଖାଆନ୍ତୁ ଏବଂ ପ୍ରଚୁର ପାଣି ପିଅନ୍ତୁ।")]);
    expect([or.language, or.script]).toEqual(["or", "Orya"]);
    const ur = detectLanguage([strip("تشخیص: Allergic Rhinitis"), strip("Tab. Montair 10 mg 0-0-1 x 15 days"), strip("مشورہ: دوائیں وقت پر لیں اور خوب پانی پئیں۔")]);
    expect([ur.language, ur.script]).toEqual(["ur", "Arab"]);
  });
  it("Marathi and Hindi are told apart; values in English don't make a page English", () => {
    expect(detectLanguage([strip("तपासणी अहवाल"), strip("Creatinine 1.42 mg/dL"), strip("औषधे वेळेवर घ्या आणि भरपूर पाणी प्या.")]).language).toBe("mr");
    expect(detectLanguage([strip("जाँच रिपोर्ट"), strip("Hemoglobin 13.5 g/dL"), strip("Sunrise Diagnostics, Pune")]).language).toBe("hi");
  });
  it("an unsupported script is 'und'; a page with no letters is English", () => {
    expect(detectLanguage(["ਰਿਪੋਰਟ ਮਰੀਜ਼ ਦਾ ਨਾਮ"]).language).toBe("und");
    expect(detectLanguage(["12/03/2026", "1-0-1"]).language).toBe("en");
  });
  it("per-line languages", () => {
    expect(detectLanguage(["निदान: x", "Hemoglobin", "12"]).lines).toEqual(["hi", "en", null]);
  });
});

describe("identifiers", () => {
  it("masks the person's names and ids, ABHA- and mobile-shaped numbers, case-insensitively", () => {
    const t = "मरीज़: RAMESH YADAV, UHID AMC-PUNE-000123, ph 98765 43210, ABHA 12-3456-7890-1234";
    const spans = identifierSpans(t, ["Ramesh Yadav", "AMC-PUNE-000123"]);
    const got = spans.map((s) => t.slice(s.start, s.end));
    expect(got).toEqual(expect.arrayContaining(["RAMESH YADAV", "AMC-PUNE-000123", "98765 43210", "12-3456-7890-1234"]));
  });
});

describe("confidence bands", () => {
  it("thresholds and band arithmetic", () => {
    expect([bandOf(0.95), bandOf(0.8), bandOf(0.6)]).toEqual(["HIGH", "MEDIUM", "LOW"]);
    expect(lowerBand("HIGH")).toBe("MEDIUM");
    expect(lowerBand("LOW")).toBe("LOW");
    expect(capBand("HIGH", "MEDIUM")).toBe("MEDIUM");
    expect(capBand("LOW", "MEDIUM")).toBe("LOW");
  });
});
