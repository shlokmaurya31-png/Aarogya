import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import sharp from "sharp";
import type { SupportedLanguage } from "../vocab";
import { FIXTURE_PAGE_KEY } from "./build";
import type { DocumentFixture } from "./types";

/**
 * Week 4b (4a follow-up c) — renders the synthetic evaluation reports as page
 * images in their own scripts, so a real-provider run reads what a phone
 * photo of an Indian report looks like (docs/DOCUMENT_PIPELINE_DESIGN.md
 * §10.1; pre-launch item 12). The marker PDFs (build.ts) stay the CI mock's
 * input; this is the real run's.
 *
 *   fonts        open fonts only (SIL OFL), shipped in assets/fonts: Noto Sans
 *                for each script (Latin, Devanagari, Bengali, Tamil, Telugu,
 *                Kannada, Malayalam, Gujarati, Odia) and Noto Nastaliq Urdu;
 *                handwriting-style Kalam (Latin, Devanagari), Gurajada
 *                (Telugu), Kavivanar (Tamil) and Atma (Bengali).
 *   shaping      Pango with HarfBuzz (inside sharp), through a private
 *                fontconfig that sees only those fonts: conjuncts, matras and
 *                Nastaliq joining are shaped, Urdu runs right to left, and no
 *                system font can sneak in (the same on macOS and Linux).
 *   noise        seeded by the sample id (deterministic): a page tilt, blur,
 *                a shadow across the page, speckle, a rubber stamp and a folded
 *                corner; handwritten pages also get blue ink, a wavering
 *                baseline and per-line tilt.
 *
 * What is drawn is the fixture's true text (the planted handwritten misreads
 * are the OCR mock's, not the page's). Every person, doctor and facility is
 * invented.
 */

export const FONT_DIR = path.resolve(process.cwd(), "assets", "fonts");

/** The font chain per language: the script's font, then Noto Sans for Latin values. */
export const PRINTED_FONTS: Record<SupportedLanguage, string[]> = {
  en: ["Noto Sans"],
  hi: ["Noto Sans Devanagari", "Noto Sans"],
  mr: ["Noto Sans Devanagari", "Noto Sans"],
  bn: ["Noto Sans Bengali", "Noto Sans"],
  ta: ["Noto Sans Tamil", "Noto Sans"],
  te: ["Noto Sans Telugu", "Noto Sans"],
  kn: ["Noto Sans Kannada", "Noto Sans"],
  ml: ["Noto Sans Malayalam", "Noto Sans"],
  gu: ["Noto Sans Gujarati", "Noto Sans"],
  or: ["Noto Sans Oriya", "Noto Sans"],
  ur: ["Noto Nastaliq Urdu", "Noto Sans"],
};

/** Handwriting-style fonts where an open one exists for the script; otherwise the printed chain, inked and noisier. */
export const HANDWRITING_FONTS: Partial<Record<SupportedLanguage, string[]>> = {
  en: ["Kalam"],
  hi: ["Kalam"],
  mr: ["Kalam"],
  te: ["Gurajada", "Kalam"],
  ta: ["Kavivanar", "Kalam"],
  bn: ["Atma", "Kalam"],
};

export const FONT_FILES: Record<string, string> = {
  "Noto Sans": "NotoSans-Regular.ttf",
  "Noto Sans Devanagari": "NotoSansDevanagari-Regular.ttf",
  "Noto Sans Bengali": "NotoSansBengali-Regular.ttf",
  "Noto Sans Tamil": "NotoSansTamil-Regular.ttf",
  "Noto Sans Telugu": "NotoSansTelugu-Regular.ttf",
  "Noto Sans Kannada": "NotoSansKannada-Regular.ttf",
  "Noto Sans Malayalam": "NotoSansMalayalam-Regular.ttf",
  "Noto Sans Gujarati": "NotoSansGujarati-Regular.ttf",
  "Noto Sans Oriya": "NotoSansOriya-Regular.ttf",
  "Noto Nastaliq Urdu": "NotoNastaliqUrdu-Regular.ttf",
  Kalam: "Kalam-Regular.ttf",
  Gurajada: "Gurajada-Regular.ttf",
  Kavivanar: "Kavivanar-Regular.ttf",
  Atma: "Atma-Regular.ttf",
};

/** The fonts a fixture's lines are drawn with (handwriting first, where it has one). */
export function fontChain(f: Pick<DocumentFixture, "language" | "handwritten">): string[] {
  const printed = PRINTED_FONTS[f.language];
  const hand = f.handwritten ? HANDWRITING_FONTS[f.language] : undefined;
  return [...new Set([...(hand ?? []), ...printed, "Noto Sans"])];
}

let fontEnvReady = false;

/**
 * Points Pango at a private fontconfig that lists only assets/fonts. Must run
 * before the first text render in the process (Pango picks its font map
 * once): the fontconfig backend, so the same fonts are used on macOS and Linux.
 */
export function ensureFontEnvironment(): void {
  if (fontEnvReady) return;
  if (!existsSync(path.join(FONT_DIR, FONT_FILES["Noto Sans"]))) throw new Error(`Fonts missing: ${FONT_DIR}`);
  const dir = path.join(tmpdir(), `aarogya-fonts-${createHash("sha256").update(FONT_DIR).digest("hex").slice(0, 12)}`);
  mkdirSync(dir, { recursive: true });
  const conf = path.join(dir, "fonts.conf");
  writeFileSync(conf, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  <dir>${FONT_DIR}</dir>\n  <cachedir>${path.join(dir, "cache")}</cachedir>\n</fontconfig>\n`);
  process.env.FONTCONFIG_FILE = conf;
  process.env.PANGOCAIRO_BACKEND = "fc";
  fontEnvReady = true;
}

/** mulberry32, seeded from the sample id: the same noise every run. */
function rng(seed: string): () => number {
  let a = createHash("sha256").update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const escapeMarkup = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const RTL = /\p{Script=Arabic}/u;

export const PAGE = { width: 1240, height: 1754, margin: 90 } as const;

/** The tilt the noisy render applies to a page (sharp's convention: positive is clockwise), from its own seeded stream. */
export function pageTilt(f: Pick<DocumentFixture, "id" | "handwritten">, pageNo = 1): number {
  const r = rng(`${f.id}#${pageNo}#tilt`);
  const sign = r() < 0.5 ? -1 : 1;
  return Math.round(sign * (0.8 + r() * (f.handwritten ? 2.4 : 1.4)) * 100) / 100;
}

async function renderLine(text: string, fonts: string[], size: number, color: string): Promise<{ data: Buffer; width: number; height: number }> {
  const r = await sharp({
    text: { text: `<span foreground="${color}">${escapeMarkup(text)}</span>`, font: `${fonts.join(", ")} ${size}`, dpi: 150, rgba: true, width: PAGE.width - 2 * PAGE.margin, wrap: "word-char" },
  }).png().toBuffer({ resolveWithObject: true });
  return { data: r.data, width: r.info.width, height: r.info.height };
}

export interface RenderOptions { noise?: boolean }

/** One fixture page as a JPEG, in its script and style (deterministic per sample). */
export async function renderFixturePage(f: DocumentFixture, pageNo = 1, opts: RenderOptions = {}): Promise<Buffer> {
  ensureFontEnvironment();
  const page = f.pages[pageNo - 1];
  if (!page) throw new Error(`${f.id}: no page ${pageNo}`);
  const noise = opts.noise ?? true;
  const rand = rng(`${f.id}#${pageNo}`);
  const fonts = fontChain(f);
  const ink = f.handwritten ? "#1d2a6e" : "#151515";
  const layers: sharp.OverlayOptions[] = [];
  let y = PAGE.margin + 10;
  for (const [i, line] of page.lines.entries()) {
    // The facility header in print, even on a handwritten prescription pad.
    const header = i === 0;
    const lineFonts = header ? fontChain({ language: f.language, handwritten: false }) : fonts;
    const size = header ? 17 : f.handwritten ? 15 + Math.round(rand() * 2) : 12;
    let img = await renderLine(line.text, lineFonts, size, header ? "#0b3d62" : ink);
    if (f.handwritten && !header && noise) {
      // A wavering hand: each line tilted a little.
      const r = await sharp(img.data).rotate((rand() - 0.5) * 2.4, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer({ resolveWithObject: true });
      img = { data: r.data, width: r.info.width, height: r.info.height };
    }
    if (y + img.height > PAGE.height - PAGE.margin) break;
    const jitter = f.handwritten && noise ? Math.round(rand() * 30) : 0;
    const left = RTL.test(line.text) ? PAGE.width - PAGE.margin - img.width - jitter : PAGE.margin + jitter;
    layers.push({ input: img.data, left: Math.max(10, left), top: y });
    y += img.height + (header ? 26 : f.handwritten ? 22 : 14);
    if (header) layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE.width - 2 * PAGE.margin}" height="3"><rect width="100%" height="3" fill="#0b3d62"/></svg>`), left: PAGE.margin, top: y - 14 });
  }
  if (noise) {
    // A rubber stamp in an empty corner, a folded corner, speckle.
    const sx = PAGE.width - PAGE.margin - 260, sy = PAGE.height - PAGE.margin - 240;
    layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><g opacity="0.45" transform="rotate(${Math.round(rand() * 40 - 20)} 120 120)"><circle cx="120" cy="120" r="100" fill="none" stroke="#b3122e" stroke-width="7"/><circle cx="120" cy="120" r="80" fill="none" stroke="#b3122e" stroke-width="3"/><rect x="40" y="105" width="160" height="30" fill="#b3122e"/></g></svg>`), left: sx, top: sy });
    const fold = 70 + Math.round(rand() * 50);
    layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${fold}" height="${fold}"><polygon points="0,0 ${fold},0 ${fold},${fold}" fill="#d9d4c7"/><polygon points="0,0 ${fold},${fold} 0,${fold}" fill="#bdb6a6"/></svg>`), left: PAGE.width - fold, top: 0 });
    const dots = Array.from({ length: 260 }, () => `<circle cx="${Math.round(rand() * PAGE.width)}" cy="${Math.round(rand() * PAGE.height)}" r="${(rand() * 1.6 + 0.4).toFixed(1)}" fill="#000" opacity="${(rand() * 0.35 + 0.1).toFixed(2)}"/>`).join("");
    layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE.width}" height="${PAGE.height}">${dots}</svg>`), left: 0, top: 0 });
    // A shadow falling across the page from one side.
    const side = rand() < 0.5 ? ["0%", "100%"] : ["100%", "0%"];
    layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE.width}" height="${PAGE.height}"><defs><linearGradient id="g" x1="${side[0]}" y1="0" x2="${side[1]}" y2="0.4"><stop offset="0" stop-color="#000" stop-opacity="0.28"/><stop offset="0.55" stop-color="#000" stop-opacity="0"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`), left: 0, top: 0 });
  }
  const paper = f.handwritten ? { r: 250, g: 247, b: 236 } : { r: 252, g: 252, b: 250 };
  let out = sharp({ create: { width: PAGE.width, height: PAGE.height, channels: 3, background: paper } }).composite(layers);
  if (!noise) return out.jpeg({ quality: 88 }).toBuffer();
  const flat = await out.png().toBuffer();
  out = sharp(flat).rotate(pageTilt(f, pageNo), { background: { r: 120, g: 116, b: 108 } }).blur(f.handwritten ? 0.9 : 0.6);
  return out.jpeg({ quality: 80 }).toBuffer();
}

/** The fixture as a PDF of its rendered pages (one image per page), carrying the CI mock's page marker too. */
export async function renderedFixturePdf(f: DocumentFixture, opts: RenderOptions = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Synthetic ${f.category} ${f.id} (rendered)`);
  doc.setSubject("aarogya-synthetic-fixture");
  doc.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  doc.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  for (let i = 0; i < f.pages.length; i++) {
    const jpg = await doc.embedJpg(await renderFixturePage(f, i + 1, opts));
    const page = doc.addPage([595, 842]);
    page.node.set(PDFName.of(FIXTURE_PAGE_KEY), PDFString.of(`${f.id}#${i + 1}`));
    page.drawImage(jpg, { x: 0, y: 0, width: 595, height: 842 });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
