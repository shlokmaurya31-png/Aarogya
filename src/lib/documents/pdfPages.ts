import path from "node:path";
import type { Line } from "@/lib/ai/documents/types";
import { normalizePageImage, type NormalizedPage } from "./normalize";

/**
 * Week 4c (4b follow-up a) — PDF pages before OCR (docs/DOCUMENT_PIPELINE_DESIGN.md
 * §15.4), with pdf.js (Apache-2.0) and @napi-rs/canvas (prebuilt; no system
 * binaries):
 *   - a page's embedded text layer is read first; if it is usable, it IS the
 *     page's text (no OCR, no provider sees the page);
 *   - if it is empty (a scan) or garbage (broken font encodings, mojibake,
 *     replacement or private-use characters), the page is rasterized, the
 *     image normalized as a photo is (2a), stored alongside, and OCR'd.
 * The original upload and its single-page PDFs are never modified.
 */
export type TextLayerVerdict = "USABLE" | "EMPTY" | "GARBAGE";

/** How text taken from a PDF's own text layer is recorded on ExtractedText. */
export const TEXT_LAYER_PROVIDER = "pdf-text-layer";
export const TEXT_LAYER_MODEL = "pdfjs-dist@5.6.205";
export const TEXT_LAYER_CONFIDENCE = 0.99;

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let lib: Promise<PdfJs> | null = null;
/**
 * pdf.js draws with the global Path2D / DOMMatrix / ImageData; in Node those
 * must be @napi-rs/canvas's own, or its context rejects the paths. They are
 * installed once, before pdf.js loads.
 */
async function loadPdfJs(): Promise<PdfJs> {
  const napi = await import("@napi-rs/canvas");
  const g = globalThis as Record<string, unknown>;
  g.Path2D = napi.Path2D;
  g.DOMMatrix ??= napi.DOMMatrix;
  g.ImageData ??= napi.ImageData;
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}
const pdfjs = () => (lib ??= loadPdfJs());
const STANDARD_FONTS = path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;

async function open(bytes: Buffer) {
  const { getDocument } = await pdfjs();
  const task = getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, standardFontDataUrl: STANDARD_FONTS, verbosity: 0 });
  return { doc: await task.promise, destroy: () => task.destroy() };
}

const BAD = /[�-\u0000-\u0008\u000E-\u001F]/gu;
const MOJIBAKE = /(Ã[\u0080-¿]|â€|Â[\u0080-¿])/gu;
const SENSIBLE = /[\p{L}\p{M}\p{N}\s.,:;()\-/%+<>=°µ'"[\]&*#@!?]/u;

/**
 * Is a page's text layer worth using? EMPTY under 20 letters or digits;
 * GARBAGE when more than 3% is replacement, private-use or control
 * characters, when it reads as mojibake, or when under 85% of it is letters,
 * digits, spaces and ordinary punctuation. Pure.
 */
export function textLayerVerdict(text: string): TextLayerVerdict {
  const t = text.normalize("NFC");
  const meaningful = (t.match(/[\p{L}\p{N}]/gu) ?? []).length;
  if (meaningful < 20) return "EMPTY";
  const chars = [...t.replace(/\s+/g, " ")];
  const bad = (t.match(BAD) ?? []).length;
  const moji = (t.match(MOJIBAKE) ?? []).length;
  const sensible = chars.filter((c) => SENSIBLE.test(c)).length;
  if (bad / chars.length > 0.03 || moji >= 3 || sensible / chars.length < 0.85) return "GARBAGE";
  return "USABLE";
}

/** The text layer of a single-page PDF as lines in reading order (top to bottom, left to right), with normalized boxes. */
export async function pdfTextLayer(bytes: Buffer): Promise<{ verdict: TextLayerVerdict; lines: Line[] }> {
  const { doc, destroy } = await open(bytes);
  try {
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    type Item = { str: string; x: number; y: number; w: number; h: number };
    const items: Item[] = [];
    for (const it of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
      if (!it.str || !it.transform) continue;
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width ?? 0, h: Math.abs(it.height ?? it.transform[3] ?? 10) });
    }
    // Group into lines by baseline (within half a line height), then order.
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows: Item[][] = [];
    for (const it of items) {
      const row = rows.find((r) => Math.abs(r[0].y - it.y) <= Math.max(2, r[0].h / 2));
      if (row) row.push(it); else rows.push([it]);
    }
    const lines: Line[] = rows.map((r) => {
      r.sort((a, b) => a.x - b.x);
      // pdf.js maps the micro sign to Greek mu; as a unit prefix (µL, µg, µmol) it is put back, so values copy exactly.
      // Items abutting each other are one word split across runs; a visible gap is a space.
      const joined = r.map((it, k) => (k > 0 && it.x - (r[k - 1].x + r[k - 1].w) > 0.15 * it.h ? " " : "") + it.str).join("");
      const text = joined.replace(/\s+/g, " ").trim().replace(/\u03BC(?=[A-Za-z])/g, "\u00B5");
      const x0 = Math.min(...r.map((i) => i.x)), x1 = Math.max(...r.map((i) => i.x + i.w)), h = Math.max(...r.map((i) => i.h));
      const top = vp.height - r[0].y - h;
      return { text, bbox: [x0 / vp.width, Math.max(0, top) / vp.height, (x1 - x0) / vp.width, h / vp.height] as [number, number, number, number], confidence: TEXT_LAYER_CONFIDENCE };
    }).filter((l) => l.text.length > 0);
    return { verdict: textLayerVerdict(lines.map((l) => l.text).join("\n")), lines };
  } finally {
    await destroy();
  }
}

/** A single-page PDF rendered to an image (long edge ~2,400 px) and normalized like a photo. */
export async function rasterizePdfPage(bytes: Buffer): Promise<NormalizedPage | "UNREADABLE" | "TOO_LARGE"> {
  let opened;
  try { opened = await open(bytes); } catch { return "UNREADABLE"; }
  const { doc, destroy } = opened;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(4, 2400 / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const { createCanvas } = await import("@napi-rs/canvas");
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas: canvas as never, canvasContext: ctx as never, viewport: vp }).promise;
    return normalizePageImage(Buffer.from(await canvas.encode("png")));
  } catch {
    return "UNREADABLE";
  } finally {
    await destroy();
  }
}
