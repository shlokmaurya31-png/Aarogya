import { afterEach, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { AI_MODEL_DEFAULTS, aiModel } from "@/lib/ai/models";
import { FIXTURES, fixtureById, fixturePdf } from "@/lib/documents/fixtures";
import { mask, placeholdersIntact, protectedSpans } from "@/lib/documents/protect";
import { FACT_VALUE_SCHEMAS, parseFactValue } from "@/lib/documents/factSchemas";
import { documentProviderKind, getDocumentProviders, mockControl, setDocumentProvidersForTest, type ProcessingPermit } from "./index";
import { mockExtraction, mockOcr, mockTagging, mockTranslation } from "./mock";
import { issuePermit } from "./permit";

const permit = issuePermit("person-test");
const canon = (t: string, v: Record<string, unknown>) => JSON.stringify([t, Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))]);
const fx = (id: string) => fixtureById(id)!;
const ocrOf = async (id: string) => mockOcr.ocrPage({ bytes: await fixturePdf(fx(id)), contentType: "application/pdf" }, {}, permit);

afterEach(() => { mockControl.reset(); setDocumentProvidersForTest(null); });

describe("provider selection", () => {
  it("uses the mocks without a key, and without the explicit opt-in even with one", () => {
    expect(documentProviderKind({})).toBe("mock");
    expect(documentProviderKind({ ANTHROPIC_API_KEY: "k" })).toBe("mock");
    expect(documentProviderKind({ DOCUMENT_AI_PROVIDER: "claude" })).toBe("mock");
    expect(documentProviderKind({ DOCUMENT_AI_PROVIDER: "claude", ANTHROPIC_API_KEY: "k" })).toBe("claude");
    expect(getDocumentProviders({}).ocr.id).toBe("mock");
  });
  it("model config: defaults, Claude-only overrides", () => {
    expect(aiModel("ocr", {})).toBe("claude-haiku-5-5");
    expect(aiModel("ocr_retry", {})).toBe("claude-sonnet-5-5");
    expect(aiModel("extraction", { AI_MODEL_EXTRACTION: "claude-sonnet-5-5" })).toBe("claude-sonnet-5-5");
    expect(aiModel("translation", { AI_MODEL_TRANSLATION: "gpt-x" })).toBe(AI_MODEL_DEFAULTS.translation);
  });
});

describe("processing permit", () => {
  it("no provider runs without an issued permit", async () => {
    const bytes = await fixturePdf(fx("lab-en-cbc"));
    await expect(mockOcr.ocrPage({ bytes, contentType: "application/pdf" }, {}, undefined as unknown as ProcessingPermit)).rejects.toThrow(/permit/);
    const forged = { personId: "p", purpose: "DOCUMENT_PROCESSING" } as unknown as ProcessingPermit;
    await expect(mockTranslation.translate("x", "hi", "en", {}, forged)).rejects.toThrow(/permit/);
    await expect(mockExtraction.extract({ text: "", layout: [], language: "en" }, forged)).rejects.toThrow(/permit/);
    await expect(mockTagging.tagMedicines("x", forged)).rejects.toThrow(/permit/);
  });
});

describe("mock OCR", () => {
  it("is deterministic and reads the fixture's page", async () => {
    const a = await ocrOf("lab-hi-kft");
    const b = await ocrOf("lab-hi-kft");
    expect(a).toEqual(b);
    expect(a.language).toBe("hi");
    expect(a.script).toBe("Deva");
    expect(a.text).toContain("Creatinine 1.42 mg/dL (0.70 - 1.30) H");
    expect(await fixturePdf(fx("lab-hi-kft"))).toEqual(await fixturePdf(fx("lab-hi-kft")));
  });
  it("applies handwritten misreads with lower confidence", async () => {
    const r = await ocrOf("rx-hw-en-1");
    expect(r.handwritten).toBe(true);
    expect(r.text).toContain("Amoxicilin");
    expect(r.text).not.toContain("Amoxicillin");
    expect(Math.min(...r.layout.map((l) => l.confidence))).toBeLessThan(0.7);
  });
  it("an unknown document or an image is UNREADABLE", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    await expect(mockOcr.ocrPage({ bytes: Buffer.from(await doc.save()), contentType: "application/pdf" }, {}, permit)).rejects.toMatchObject({ code: "UNREADABLE" });
    await expect(mockOcr.ocrPage({ bytes: Buffer.from("not a pdf"), contentType: "image/png" }, {}, permit)).rejects.toMatchObject({ code: "UNREADABLE" });
  });
  it("injected transient failures, then success", async () => {
    mockControl.ocrTransientFailures = 2;
    await expect(ocrOf("lab-en-cbc")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(ocrOf("lab-en-cbc")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await expect(ocrOf("lab-en-cbc")).resolves.toMatchObject({ language: "en" });
    expect(mockControl.ocrCalls).toBe(3);
  });
});

describe("mock translation", () => {
  it("translates labels, passes placeholders through, deterministic", async () => {
    const r = await ocrOf("lab-hi-kft");
    const m = mask(r.text, protectedSpans(r.text, ["Metformin"]));
    const t1 = await mockTranslation.translate(m.masked, "hi", "en", {}, permit);
    const t2 = await mockTranslation.translate(m.masked, "hi", "en", {}, permit);
    expect(t1).toEqual(t2);
    expect(t1.text).toContain("Laboratory Report");
    expect(t1.text).not.toContain("जाँच रिपोर्ट");
    expect(placeholdersIntact(t1.text, m.originals.length)).toBe(true);
  });
  it("each corruption mode is caught by the placeholder check", async () => {
    const r = await ocrOf("lab-en-cbc");
    const m = mask(r.text, protectedSpans(r.text, []));
    for (const mode of ["drop", "alter", "duplicate"] as const) {
      mockControl.translationCorruption = { mode, times: 1 };
      const t = await mockTranslation.translate(m.masked, "en", "hi", {}, permit);
      expect(placeholdersIntact(t.text, m.originals.length), mode).toBe(false);
    }
  });
  it("refuses an unsupported language", async () => {
    await expect(mockTranslation.translate("x", "hi", "fr", {}, permit)).rejects.toMatchObject({ code: "UNSUPPORTED_LANGUAGE" });
  });
});

describe("mock extraction", () => {
  it("finds every printed fact of every non-handwritten fixture, schema-valid, verbatim", async () => {
    for (const f of FIXTURES.filter((x) => !x.handwritten)) {
      const r = await ocrOf(f.id);
      const { facts } = await mockExtraction.extract({ text: r.text, layout: r.layout, language: r.language }, permit);
      for (const fact of facts) {
        expect(parseFactValue(fact.factType, fact.value).success, `${f.id} ${fact.factType}`).toBe(true);
        for (const line of fact.sourceText.split("\n")) expect(r.text).toContain(line);
      }
      const got = facts.map((x) => canon(x.factType, x.value));
      for (const e of f.expected) expect(got, f.id).toContain(canon(e.factType, e.value));
      expect(facts.length, f.id).toBe(f.expected.length);
    }
  });
  it("handwritten misreads give a wrong (verbatim) value, never an invented one", async () => {
    const r = await ocrOf("rx-hw-en-1");
    const { facts } = await mockExtraction.extract({ text: r.text, layout: r.layout, language: r.language }, permit);
    const amox = facts.find((x) => x.factType === "MEDICATION" && String(x.value.name).startsWith("Amox"));
    expect(amox?.value.name).toBe("Amoxicilin");
  });
});

describe("mock tagging and schemas", () => {
  it("tags fixture brand names only where they occur", async () => {
    expect((await mockTagging.tagMedicines("Tab. Dolo 650 mg SOS", permit)).names).toEqual(["Dolo"]);
    expect((await mockTagging.tagMedicines("Dolomite", permit)).names).toEqual([]);
  });
  it("fact values are strict", () => {
    expect(FACT_VALUE_SCHEMAS.ALLERGY.safeParse({ substance: "Penicillin", note: "x" }).success).toBe(false);
    expect(FACT_VALUE_SCHEMAS.MEDICATION.safeParse({ frequency: "1-0-1" }).success).toBe(false);
    expect(FACT_VALUE_SCHEMAS.LAB_VALUE.safeParse({ analyte: "Hb", value: "12", unit: "g/dL", comment: "x" }).success).toBe(false);
  });
});

describe("Claude providers (stubbed client: no network)", async () => {
  const { ClaudeDocumentClient, claudeExtraction, claudeTagging, claudeOcr } = await import("./claude");
  const stub = (out: unknown) => {
    const c = new ClaudeDocumentClient("test-key");
    const calls: { model: string; system: string }[] = [];
    c.toolCall = (async (a: { model: string; system: string; schema: { parse: (x: unknown) => unknown } }) => { calls.push(a); return a.schema.parse(out); }) as typeof c.toolCall;
    return { c, calls };
  };
  it("tagging keeps only names that occur in the text", async () => {
    const { c } = stub({ names: ["Dolo", "Crocin", " Dolo "] });
    expect((await claudeTagging(c).tagMedicines("Tab. Dolo 650 mg", permit)).names).toEqual(["Dolo"]);
  });
  it("extraction drops malformed candidates rather than repairing them", async () => {
    const { c } = stub({ facts: [{ factType: "ALLERGY", value: { substance: "Penicillin" }, sourceText: "Allergy: Penicillin", lines: [0] }, { factType: "NOPE", value: {}, sourceText: "x", lines: [] }] });
    const r = await claudeExtraction(c).extract({ text: "Allergy: Penicillin", layout: [{ text: "Allergy: Penicillin", bbox: [0, 0, 1, 1], confidence: 0.9 }], language: "en" }, permit);
    expect(r.facts).toHaveLength(1);
    expect(r.model).toBe("claude-haiku-5-5");
  });
  it("OCR retry uses the retry model; no permit, no call", async () => {
    const { c, calls } = stub({ lines: [{ text: "Hb 12.1 g/dL", bbox: [0, 0, 1, 0.1], confidence: 0.8 }], language: "en", script: "Latn", handwritten: true, confidence: 0.8 });
    const r = await claudeOcr(c).ocrPage({ bytes: Buffer.from("%PDF"), contentType: "application/pdf" }, { retry: true }, permit);
    expect(r.model).toBe("claude-sonnet-5-5");
    await expect(claudeOcr(c).ocrPage({ bytes: Buffer.from("%PDF"), contentType: "application/pdf" }, {}, {} as ProcessingPermit)).rejects.toThrow(/permit/);
    expect(calls).toHaveLength(1);
  });
});
