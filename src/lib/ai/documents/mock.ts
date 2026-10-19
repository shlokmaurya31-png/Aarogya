import { createHash } from "node:crypto";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { FIXTURES, FIXTURE_PAGE_KEY, fixtureById, ocrLines } from "@/lib/documents/fixtures";
import { UNITS } from "@/lib/documents/protect";
import { LABELS, LANGUAGE_SCRIPT, SUPPORTED_LANGUAGES, labelsFor, type LabelKey, type SupportedLanguage } from "@/lib/documents/vocab";
import type { DOCUMENT_TYPES } from "@/lib/documents/factSchemas";
import { assertPermit } from "./permit";
import { DocumentProviderError, type CandidateFact, type FactExtractor, type Line, type MedicineTagger, type TranslationProvider, type VisionOcrProvider } from "./types";

/**
 * Week 4a — deterministic mocks of the document providers
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §6). Used whenever no Claude provider is
 * configured, and always in CI.
 *
 *   OCR          reads the fixture marker on a synthetic PDF page, or looks an
 *                image page up by its sha256 (images registered with
 *                `mockControl.imagePages`), and returns that fixture page's
 *                lines (with its handwritten misreads); anything else is
 *                UNREADABLE.
 *   translation  a phrase glossary per language pair built from the label
 *                vocabulary; placeholders pass through untouched.
 *   extraction   rules over the page's lines (labels, lab-value and
 *                prescription-line patterns); never looks at the fixture's
 *                expected facts.
 *   tagging      the fixtures' brand names, where they occur.
 *
 * `mockControl` lets tests and gates inject transient failures and
 * translation corruption. It is inert unless a test sets it.
 */
export const mockControl = {
  /** The next N OCR calls fail with PROVIDER_UNAVAILABLE. */
  ocrTransientFailures: 0,
  /** OCR calls made (to prove a resumed run doesn't redo pages). */
  ocrCalls: 0,
  /** Corrupt translations: drop, alter or duplicate a placeholder. `times` limits it (Infinity: always). */
  translationCorruption: { mode: "none" as "none" | "drop" | "alter" | "duplicate", times: 0 },
  /** Image pages the OCR mock can read: sha256 of the page bytes → "fixtureId#pageNo". */
  imagePages: new Map<string, string>(),
  reset() {
    this.imagePages.clear();
    this.ocrTransientFailures = 0;
    this.ocrCalls = 0;
    this.translationCorruption = { mode: "none", times: 0 };
  },
};

const MOCK_MODEL = "mock-1";

async function fixtureMarker(bytes: Buffer): Promise<string | null> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    if (doc.getPageCount() !== 1) return null;
    const v = doc.getPage(0).node.get(PDFName.of(FIXTURE_PAGE_KEY));
    return v instanceof PDFString ? v.decodeText() : null;
  } catch {
    return null;
  }
}

export const mockOcr: VisionOcrProvider = {
  id: "mock",
  async ocrPage(page, _hints, permit) {
    assertPermit(permit);
    mockControl.ocrCalls += 1;
    if (mockControl.ocrTransientFailures > 0) {
      mockControl.ocrTransientFailures -= 1;
      throw new DocumentProviderError("PROVIDER_UNAVAILABLE");
    }
    const marker = page.contentType === "application/pdf" ? await fixtureMarker(page.bytes) : mockControl.imagePages.get(createHash("sha256").update(page.bytes).digest("hex")) ?? null;
    const [id, n] = marker?.split("#") ?? [];
    const f = id ? fixtureById(id) : undefined;
    const lines = f ? ocrLines(f, Number(n)) : [];
    if (!f || !lines.length) throw new DocumentProviderError("UNREADABLE");
    const layout: Line[] = lines.map((l, i) => ({ text: l.text, confidence: l.confidence, bbox: [0.05, (i + 1) / (lines.length + 2), 0.9, 1 / (lines.length + 2)] }));
    const confidence = Math.round((layout.reduce((s, l) => s + l.confidence, 0) / layout.length) * 1000) / 1000;
    return { text: layout.map((l) => l.text).join("\n"), layout, language: f.mixed ? "mixed" : f.language, script: LANGUAGE_SCRIPT[f.language], handwritten: f.handwritten, confidence, model: MOCK_MODEL };
  },
};

const PLACEHOLDER = /⟦P\d+⟧/g;

function corrupt(text: string): string {
  const c = mockControl.translationCorruption;
  if (c.mode === "none" || c.times <= 0) return text;
  const first = text.match(PLACEHOLDER)?.[0];
  if (!first) return text;
  c.times -= 1;
  if (c.mode === "drop") return text.replace(first, "");
  if (c.mode === "alter") return text.replace(first, first.replace(/\d+/, (d) => String(Number(d) + 100)));
  return text.replace(first, `${first} ${first}`);
}

export const mockTranslation: TranslationProvider = {
  id: "mock",
  async translate(text, from, to, _opts, permit) {
    assertPermit(permit);
    if (!(SUPPORTED_LANGUAGES as readonly string[]).includes(to)) throw new DocumentProviderError("UNSUPPORTED_LANGUAGE");
    const sources = from === "mixed" ? SUPPORTED_LANGUAGES.filter((l) => l !== to) : [from as SupportedLanguage];
    if (!sources.every((l) => (SUPPORTED_LANGUAGES as readonly string[]).includes(l))) throw new DocumentProviderError("UNSUPPORTED_LANGUAGE");
    const pairs: [string, string][] = [];
    for (const l of sources) for (const k of Object.keys(LABELS[l]) as LabelKey[]) if (LABELS[l][k] !== LABELS[to as SupportedLanguage][k]) pairs.push([LABELS[l][k], LABELS[to as SupportedLanguage][k]]);
    pairs.sort((a, b) => b[0].length - a[0].length);
    // One pass, longest phrase first, so a replacement is never re-translated.
    const alt = new RegExp(pairs.map(([s]) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gu");
    const map = new Map(pairs);
    const out = pairs.length ? text.replace(alt, (m) => map.get(m) ?? m) : text;
    return { text: corrupt(out), model: MOCK_MODEL };
  },
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const anyLabel = (key: LabelKey) => labelsFor(key).sort((a, b) => b.length - a.length).map(esc).join("|");
const ANY_LABEL = (keys: LabelKey[]) => `(?:${keys.map(anyLabel).join("|")})`;
const labelled = (keys: LabelKey[]) => new RegExp(`^${ANY_LABEL(keys)}(?:\\s*/\\s*${ANY_LABEL(keys)})?\\s*:\\s*(.+)$`, "u");

const RULES = {
  diagnosis: labelled(["diagnosis", "impression"]),
  allergy: labelled(["allergy"]),
  procedure: labelled(["procedure"]),
  date: labelled(["date"]),
  doctor: /^(Dr\.\s+[A-Z][\w.' -]+)$/u,
  reg: /^Reg\.\s*No\.\s*(\S+)$/u,
  med: /^(Tab\.|Cap\.|Syp\.|Inj\.)\s+(.+?)\s+(\d+(?:\.\d+)?\s?(?:mg|mcg|g|ml|mL|IU|units))\s+(\d(?:-\d){2,3}|OD|BD|TDS|QID|HS|SOS|STAT|WEEKLY)(?:\s+x\s+(\d+\s+(?:days|weeks|months)))?$/u,
  lab: new RegExp(`^([A-Za-z][A-Za-z0-9 .\\-]*?)\\s+(\\d+(?:\\.\\d+)?)\\s+(${[...UNITS].sort((a, b) => b.length - a.length).map(esc).join("|")})(?:\\s+\\(([^)]+)\\))?(?:\\s+(H|L))?$`, "u"),
};
const TITLES: [LabelKey, (typeof DOCUMENT_TYPES)[number]][] = [["labReport", "LAB_REPORT"], ["prescription", "PRESCRIPTION"], ["dischargeSummary", "DISCHARGE_SUMMARY"], ["imagingReport", "IMAGING_REPORT"]];
const FREQ_CODE: Record<string, string> = { "1-0-0": "OD", "0-0-1": "HS", "1-0-1": "BD", "1-1-1": "TDS", "1-1-1-1": "QID", OD: "OD", BD: "BD", TDS: "TDS", QID: "QID", HS: "HS", SOS: "SOS", STAT: "STAT", WEEKLY: "WEEKLY" };

export const mockExtraction: FactExtractor = {
  id: "mock",
  async extract(page, permit) {
    assertPermit(permit);
    const facts: CandidateFact[] = [];
    const meta: Record<string, string> = {};
    const metaLines: number[] = [];
    page.layout.forEach((l, i) => {
      const t = l.text.trim();
      let m: RegExpMatchArray | null;
      if (i === 0 && !RULES.lab.test(t)) { meta.facilityName = t; metaLines.push(i); return; }
      const title = TITLES.find(([k]) => new RegExp(`^${ANY_LABEL([k])}(?:\\s*/\\s*${ANY_LABEL([k])})?$`, "u").test(t));
      if (title) { meta.documentType = title[1]; metaLines.push(i); return; }
      if ((m = t.match(RULES.date))) { meta.documentDate = m[1]; metaLines.push(i); return; }
      if ((m = t.match(RULES.doctor))) { meta.doctorName = m[1]; metaLines.push(i); return; }
      if ((m = t.match(RULES.reg))) { meta.registrationNo = m[1]; metaLines.push(i); return; }
      if ((m = t.match(RULES.allergy))) return void facts.push({ factType: "ALLERGY", value: { substance: m[1] }, sourceText: t, lines: [i] });
      if ((m = t.match(RULES.procedure))) return void facts.push({ factType: "PROCEDURE", value: { text: m[1] }, sourceText: t, lines: [i] });
      if ((m = t.match(RULES.diagnosis))) return void facts.push({ factType: "DIAGNOSIS", value: { text: m[1] }, sourceText: t, lines: [i] });
      if ((m = t.match(RULES.med))) {
        const value: Record<string, unknown> = { name: m[2], form: m[1], dose: m[3], frequency: m[4] };
        if (FREQ_CODE[m[4]]) value.frequencyCode = FREQ_CODE[m[4]];
        if (m[5]) value.duration = m[5];
        return void facts.push({ factType: "MEDICATION", value, sourceText: t, lines: [i] });
      }
      if ((m = t.match(RULES.lab))) {
        const value: Record<string, unknown> = { analyte: m[1], value: m[2], numericValue: Number(m[2]), unit: m[3] };
        if (m[4]) value.referenceRange = m[4];
        if (m[5]) value.flag = m[5];
        return void facts.push({ factType: "LAB_VALUE", value, sourceText: t, lines: [i] });
      }
    });
    if (meta.documentType) facts.unshift({ factType: "DOCUMENT_META", value: meta, sourceText: metaLines.map((i) => page.layout[i].text).join("\n"), lines: metaLines });
    return { facts, model: MOCK_MODEL };
  },
};

export const mockTagging: MedicineTagger = {
  id: "mock",
  async tagMedicines(text, permit) {
    assertPermit(permit);
    const brands = [...new Set(FIXTURES.flatMap((f) => f.brands))];
    return { names: brands.filter((b) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(b)}(?![\\p{L}\\p{N}])`, "u").test(text)), model: MOCK_MODEL };
  },
};
