/**
 * Phase 1.2 — low-level PDF primitives over pdf-lib.
 *
 * pdf-lib is pure JS (no headless browser, no native deps) so this renders in a
 * serverless function. This module owns page geometry, fonts, wrapped text, key/
 * value rows, tables, a QR block, draft watermark and page-number footer. The
 * layout engine (layout.ts) composes documents from these; templates never call
 * pdf-lib directly.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";

// A4 in points.
export const PAGE_WIDTH = 595.28;
export const PAGE_HEIGHT = 841.89;
export const MARGIN = 48;
export const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const INK = rgb(0.09, 0.09, 0.11);
const MUTED = rgb(0.42, 0.45, 0.5);
const LINE = rgb(0.82, 0.84, 0.87);
const BRAND = rgb(0.05, 0.5, 0.5); // teal, matching the product

export interface RenderCtx {
  pdf: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  /** Current baseline cursor, measured from the top of the page. */
  y: number;
}

export async function newDocument(): Promise<Omit<RenderCtx, "y"> & { y: number }> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  return { pdf, page, font, bold, y: MARGIN };
}

/** Break a string into lines that fit `maxWidth` at `size`. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const words = rawLine.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) out.push(line);
        // A single word longer than the width is hard-split.
        if (font.widthOfTextAtSize(word, size) > maxWidth) {
          let chunk = "";
          for (const ch of word) {
            if (font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
              out.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else {
          line = word;
        }
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/** Ensure at least `needed` points remain; start a new page if not. Returns ctx. */
export function ensureSpace(ctx: RenderCtx, needed: number): RenderCtx {
  if (ctx.y + needed > PAGE_HEIGHT - MARGIN) {
    ctx.page = ctx.pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    ctx.y = MARGIN;
  }
  return ctx;
}

const yTop = (ctx: RenderCtx) => PAGE_HEIGHT - ctx.y;

export function drawText(
  ctx: RenderCtx,
  text: string,
  opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; maxWidth?: number; lineGap?: number } = {}
): void {
  const size = opts.size ?? 10;
  const font = opts.bold ? ctx.bold : ctx.font;
  const color = opts.color ?? INK;
  const x = opts.x ?? MARGIN;
  const maxWidth = opts.maxWidth ?? CONTENT_WIDTH - (x - MARGIN);
  const lineGap = opts.lineGap ?? 4;
  for (const line of wrapText(text, font, size, maxWidth)) {
    ensureSpace(ctx, size + lineGap);
    ctx.page.drawText(line, { x, y: yTop(ctx) - size, size, font, color });
    ctx.y += size + lineGap;
  }
}

export function drawKeyValueRow(ctx: RenderCtx, label: string, value: string): void {
  const size = 10;
  const labelWidth = 150;
  ensureSpace(ctx, size + 5);
  const baseY = yTop(ctx) - size;
  ctx.page.drawText(label, { x: MARGIN, y: baseY, size, font: ctx.bold, color: MUTED });
  const valueLines = wrapText(value || "-", ctx.font, size, CONTENT_WIDTH - labelWidth);
  ctx.page.drawText(valueLines[0] ?? "-", { x: MARGIN + labelWidth, y: baseY, size, font: ctx.font, color: INK });
  ctx.y += size + 5;
  for (const extra of valueLines.slice(1)) {
    ensureSpace(ctx, size + 3);
    ctx.page.drawText(extra, { x: MARGIN + labelWidth, y: yTop(ctx) - size, size, font: ctx.font, color: INK });
    ctx.y += size + 3;
  }
}

export function drawDivider(ctx: RenderCtx, color = LINE): void {
  ensureSpace(ctx, 10);
  ctx.y += 4;
  ctx.page.drawLine({ start: { x: MARGIN, y: yTop(ctx) }, end: { x: PAGE_WIDTH - MARGIN, y: yTop(ctx) }, thickness: 0.75, color });
  ctx.y += 8;
}

export function drawSpacer(ctx: RenderCtx, pts = 8): void {
  ctx.y += pts;
}

/** Draw a simple table. `widths` are fractions of CONTENT_WIDTH summing to ~1. */
export function drawTable(ctx: RenderCtx, headers: string[], rows: string[][], widths: number[]): void {
  const size = 9.5;
  const cellPad = 4;
  const colX = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((a, w) => a + w * CONTENT_WIDTH, 0));

  const drawRow = (cells: string[], isHeader: boolean) => {
    const wrapped = cells.map((c, i) => wrapText(c || "", isHeader ? ctx.bold : ctx.font, size, widths[i] * CONTENT_WIDTH - cellPad * 2));
    const rowHeight = Math.max(...wrapped.map((w) => w.length)) * (size + 3) + cellPad * 2;
    ensureSpace(ctx, rowHeight);
    const top = yTop(ctx);
    if (isHeader) {
      ctx.page.drawRectangle({ x: MARGIN, y: top - rowHeight, width: CONTENT_WIDTH, height: rowHeight, color: rgb(0.95, 0.97, 0.97) });
    }
    wrapped.forEach((lines, i) => {
      lines.forEach((line, li) => {
        ctx.page.drawText(line, {
          x: colX[i] + cellPad,
          y: top - cellPad - size - li * (size + 3),
          size,
          font: isHeader ? ctx.bold : ctx.font,
          color: isHeader ? INK : rgb(0.15, 0.15, 0.18),
        });
      });
    });
    ctx.y += rowHeight;
    ctx.page.drawLine({ start: { x: MARGIN, y: yTop(ctx) }, end: { x: PAGE_WIDTH - MARGIN, y: yTop(ctx) }, thickness: 0.5, color: LINE });
  };

  drawRow(headers, true);
  for (const row of rows) drawRow(row, false);
}

/** Embed a QR code (as PNG) plus a caption at the current cursor, right-aligned. */
export async function drawQrBlock(ctx: RenderCtx, url: string, caption: string): Promise<void> {
  const pngBytes = await QRCode.toBuffer(url, { type: "png", margin: 1, width: 120 });
  const png = await ctx.pdf.embedPng(pngBytes);
  const dim = 72;
  ensureSpace(ctx, dim + 14);
  const x = PAGE_WIDTH - MARGIN - dim;
  ctx.page.drawImage(png, { x, y: yTop(ctx) - dim, width: dim, height: dim });
  ctx.page.drawText(caption, { x: x - 4, y: yTop(ctx) - dim - 10, size: 7, font: ctx.font, color: MUTED });
  ctx.y += dim + 14;
}

/** Overlay a diagonal DRAFT watermark on every page. */
export function applyDraftWatermark(ctx: RenderCtx): void {
  for (const page of ctx.pdf.getPages()) {
    page.drawText("DRAFT", {
      x: 130,
      y: 380,
      size: 120,
      font: ctx.bold,
      color: rgb(0.9, 0.9, 0.9),
      rotate: { type: "degrees", angle: 45 } as never,
      opacity: 0.4,
    });
  }
}

/** Footer with page N of M on every page. Call last. */
export function applyFooters(ctx: RenderCtx, footerNote: string): void {
  const pages = ctx.pdf.getPages();
  pages.forEach((page, i) => {
    page.drawLine({ start: { x: MARGIN, y: MARGIN - 14 }, end: { x: PAGE_WIDTH - MARGIN, y: MARGIN - 14 }, thickness: 0.5, color: LINE });
    page.drawText(footerNote, { x: MARGIN, y: MARGIN - 26, size: 7, font: ctx.font, color: MUTED });
    const label = `Page ${i + 1} of ${pages.length}`;
    const w = ctx.font.widthOfTextAtSize(label, 7);
    page.drawText(label, { x: PAGE_WIDTH - MARGIN - w, y: MARGIN - 26, size: 7, font: ctx.font, color: MUTED });
  });
}

export { INK, MUTED, LINE, BRAND };
