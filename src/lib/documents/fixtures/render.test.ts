import { describe, expect, it } from "vitest";
import path from "node:path";
import { createHash } from "node:crypto";
import * as fontkit from "fontkit";
import sharp from "sharp";
import { FIXTURES } from "./index";
import { FONT_DIR, FONT_FILES, fontChain, HANDWRITING_FONTS, pageTilt, PRINTED_FONTS, renderedFixturePdf, renderFixturePage } from "./render";
import { SUPPORTED_LANGUAGES } from "../vocab";
import { normalizePageImage } from "../normalize";

/**
 * Week 4b (4a follow-up c) — the multi-script renderer: every character every
 * sample prints has a glyph in the fonts that sample is drawn with (no tofu,
 * no system font), every language renders, and the output is deterministic.
 */
const fonts = new Map(Object.entries(FONT_FILES).map(([family, file]) => [family, fontkit.openSync(path.join(FONT_DIR, file)) as fontkit.Font]));

function uncovered(text: string, chain: string[]): string[] {
  const missing: string[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    // Whitespace and joiners need no glyph of their own.
    if (/\s/u.test(ch) || cp === 0x200c || cp === 0x200d) continue;
    if (!chain.some((family) => fonts.get(family)!.hasGlyphForCodePoint(cp))) missing.push(`${ch} U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  return missing;
}

describe("multi-script renderer", () => {
  it("has a printed font for every supported language, and each font file is what it says", () => {
    expect(Object.keys(PRINTED_FONTS).sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
    for (const [family, font] of fonts) expect(font.familyName, family).toBe(family);
    for (const chain of [...Object.values(PRINTED_FONTS), ...Object.values(HANDWRITING_FONTS)]) for (const family of chain) expect(FONT_FILES[family], family).toBeDefined();
  });

  it("covers every character of every sample with the sample's own fonts", () => {
    const problems = FIXTURES.flatMap((f) => f.pages.flatMap((p) => p.lines.flatMap((l, i) => {
      // The header line is always printed; the rest in the sample's style.
      const chain = i === 0 ? fontChain({ language: f.language, handwritten: false }) : fontChain(f);
      const missing = uncovered(l.text, chain);
      return missing.length ? [`${f.id} line ${i + 1}: ${missing.join(", ")}`] : [];
    })));
    expect(problems).toEqual([]);
  });

  it("draws handwritten-style samples in a handwriting font where one exists for the script", () => {
    for (const f of FIXTURES.filter((x) => x.handwritten)) expect(HANDWRITING_FONTS[f.language], f.id).toBeDefined();
  });

  it.each(SUPPORTED_LANGUAGES.map((l) => [l]))("renders a %s sample: a page with ink on it", async (language) => {
    const f = FIXTURES.find((x) => x.language === language)!;
    const jpg = await renderFixturePage(f, 1, { noise: false });
    const meta = await sharp(jpg).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([1240, 1754]);
    const { data } = await sharp(jpg).greyscale().raw().toBuffer({ resolveWithObject: true });
    const dark = data.reduce((n, v) => n + (v < 128 ? 1 : 0), 0) / data.length;
    expect(dark, f.id).toBeGreaterThan(0.002);
  }, 30_000);

  it("is deterministic, noise included", async () => {
    const f = FIXTURES.find((x) => x.id === "rx-hw-te-1")!;
    const a = await renderFixturePage(f);
    const b = await renderFixturePage(f);
    expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"));
  }, 30_000);

  it.each(["lab-hi-kft", "rx-ur-1", "rx-hw-te-1", "img-ml-usg", "mixed-ta-lipid", "dc-kn"].map((id) => [id]))("the normalizer undoes the render's tilt on %s (within 0.5°)", async (id) => {
    const f = FIXTURES.find((x) => x.id === id)!;
    const n = await normalizePageImage(await renderFixturePage(f));
    if (typeof n === "string") throw new Error(n);
    expect(Math.abs(n.normalization.deskewDegrees + pageTilt(f))).toBeLessThan(0.5);
  }, 30_000);

  it("makes a rendered PDF that still carries the mock's page marker", async () => {
    const f = FIXTURES.find((x) => x.id === "img-or-ct")!;
    const pdf = await renderedFixturePdf(f, { noise: false });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.toString("latin1")).toContain("img-or-ct#1");
  }, 30_000);
});
