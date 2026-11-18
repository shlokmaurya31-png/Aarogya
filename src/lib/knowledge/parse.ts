import type { KnowledgeFormat } from "./formats";
import { decodeText } from "./formats";
import { furnitureKey, isPageNumberLine, normalizeLine, normalizeText, repeatedLines } from "./normalize";

/**
 * RAG Phase 2, steps 2.3–2.4 — a knowledge file read into pages of blocks:
 * headings (with their level), paragraphs and tables (a header row and its
 * rows, kept whole). Every format comes out in this one shape, so the chunker
 * never knows where a document came from.
 *
 *   PDF       each page's text layer (pdf.js), lines rebuilt from their
 *             positions; larger or numbered short lines are headings; lines
 *             with the same column gaps are a table; running headers,
 *             footers and page numbers removed. A page with no usable text
 *             (a scan) is refused with NO_TEXT_LAYER: no provider sees a
 *             knowledge page (OCR for knowledge is not built; see the plan).
 *   Text      blank-line paragraphs; numbered, all-capitals or colon-ended
 *             short lines are headings; pipe- or tab-separated runs are tables
 *   Markdown  # headings, pipe tables, lists and paragraphs
 *   HTML      h1–h6, p, li, table (th/td); script, style, comments and
 *             everything in <head> dropped; entities decoded. Nothing is run.
 *   CSV       one table (RFC 4180 quoting)
 *   JSON      nested keys as headings, uniform arrays of objects as tables,
 *             other values as "key: value" lines
 *
 * Text from a document is data: an instruction inside it ("ignore previous
 * instructions…") is a paragraph like any other.
 */
export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "table"; header: string[]; rows: string[][] };

export interface ParsedPage { pageNumber: number | null; blocks: Block[] }
export interface ParsedDocument { pages: ParsedPage[]; pageCount: number | null }

export type ParseRefusal = "UNREADABLE" | "NO_TEXT_LAYER" | "NO_TEXT" | "TOO_MANY_PAGES";
export class KnowledgeParseError extends Error {
  constructor(readonly code: ParseRefusal) {
    super(`Knowledge parse refused: ${code}`);
  }
}

export const KNOWLEDGE_MAX_PAGES = 500;
const EDGE_BAND = 0.07;

export async function parseKnowledgeFile(format: KnowledgeFormat, bytes: Buffer): Promise<ParsedDocument> {
  let doc: ParsedDocument;
  if (format === "PDF") doc = await parsePdf(bytes);
  else {
    const text = decodeText(bytes);
    if (text === null) throw new KnowledgeParseError("UNREADABLE");
    const blocks = format === "MARKDOWN" ? parseMarkdown(text)
      : format === "HTML" ? parseHtml(text)
      : format === "CSV" ? parseCsvBlocks(text)
      : format === "JSON" ? parseJsonBlocks(text)
      : parsePlainText(text);
    doc = { pages: [{ pageNumber: null, blocks }], pageCount: null };
  }
  if (!doc.pages.some((p) => p.blocks.some((b) => b.type !== "heading"))) throw new KnowledgeParseError("NO_TEXT");
  return doc;
}

/** Every block's text as one string (for the identifier check and the fidelity measure). */
export function documentText(doc: ParsedDocument): string {
  return doc.pages.flatMap((p) => p.blocks.map((b) => (b.type === "table" ? [b.header, ...b.rows].map((r) => r.join(" | ")).join("\n") : b.text))).join("\n");
}

// ── tables in plain text ─────────────────────────────────────────────────────

function splitRow(line: string): string[] | null {
  if (line.includes("|")) {
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => normalizeLine(c));
    return cells.length >= 2 ? cells : null;
  }
  if (line.includes("\t")) {
    const cells = line.split("\t").map((c) => normalizeLine(c));
    return cells.length >= 2 ? cells : null;
  }
  return null;
}
const SEPARATOR_ROW = (cells: string[]) => cells.every((c) => /^:?-{2,}:?$/.test(c));

function tableFrom(rows: string[][]): Block {
  const body = rows.slice(1).filter((r) => !SEPARATOR_ROW(r));
  const width = rows[0].length;
  return { type: "table", header: rows[0], rows: body.map((r) => (r.length === width ? r : [...r, ...Array(Math.max(0, width - r.length)).fill("")].slice(0, Math.max(width, r.length)))) };
}

// ── plain text ───────────────────────────────────────────────────────────────

const NUMBERED_HEADING = /^(?:\d+(?:\.\d+)*\.?|[IVX]+\.|[A-Z]\.)\s+\S.{0,80}$/u;
function headingLevelOf(line: string): number | null {
  const t = line.trim();
  if (t.length < 2 || t.length > 90 || /[.;,]$/.test(t)) return null;
  const num = t.match(/^(\d+(?:\.\d+)*)\.?\s+\p{L}/u);
  if (num) return Math.min(6, num[1].split(".").length);
  if (NUMBERED_HEADING.test(t) && /^[IVX]+\.|^[A-Z]\./.test(t)) return 1;
  const letters = t.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 3 && letters === letters.toUpperCase() && /\p{Lu}/u.test(letters) && !/\d{2,}/.test(t)) return 1;
  if (/:$/.test(t) && t.split(/\s+/).length <= 8) return 2;
  return null;
}

export function parsePlainText(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let table: string[][] = [];
  const flushPara = () => { if (para.length) blocks.push({ type: "paragraph", text: para.join(" ") }); para = []; };
  const flushTable = () => {
    if (table.length >= 2) blocks.push(tableFrom(table));
    else if (table.length === 1) para.push(table[0].join(" "));
    table = [];
  };
  for (const raw of text.normalize("NFC").replace(/\r\n?/g, "\n").split("\n")) {
    const row = splitRow(raw);
    if (row && (!table.length || row.length === table[0].length || SEPARATOR_ROW(row))) { flushPara(); table.push(row); continue; }
    flushTable();
    const line = normalizeLine(raw);
    if (!line) { flushPara(); continue; }
    const level = headingLevelOf(line);
    if (level !== null && para.length === 0) { blocks.push({ type: "heading", level, text: line.replace(/:$/, "") }); continue; }
    para.push(line);
  }
  flushTable();
  flushPara();
  return blocks;
}

// ── Markdown ─────────────────────────────────────────────────────────────────

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let table: string[][] = [];
  let fence = false;
  const flushPara = () => { if (para.length) blocks.push({ type: "paragraph", text: para.join(" ") }); para = []; };
  const flushTable = () => { if (table.length >= 2) blocks.push(tableFrom(table)); else if (table.length) para.push(table[0].join(" ")); table = []; };
  for (const raw of text.normalize("NFC").replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) { flushTable(); flushPara(); fence = !fence; continue; }
    if (fence) { const l = normalizeLine(raw); if (l) para.push(l); continue; }
    const row = raw.trim().startsWith("|") ? splitRow(raw) : null;
    if (row) { flushPara(); table.push(row); continue; }
    flushTable();
    const h = raw.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { flushPara(); blocks.push({ type: "heading", level: h[1].length, text: normalizeLine(stripInline(h[2])) }); continue; }
    const line = normalizeLine(stripInline(raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "• ").replace(/^\s*>\s?/, "")));
    if (!line) { flushPara(); continue; }
    if (/^• /.test(line) && para.length && !/^• /.test(para[0])) flushPara();
    para.push(line);
  }
  flushTable();
  flushPara();
  return blocks;
}

/** Markdown emphasis and links read as their text; nothing else changes. */
function stripInline(s: string): string {
  return s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(?<![\w*])\*(?!\s)(.+?)\*(?!\w)/g, "$1").replace(/`([^`]+)`/g, "$1");
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", deg: "°", micro: "µ", plusmn: "±", le: "≤", ge: "≥", times: "×", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…", middot: "·", reg: "®", trade: "™", copy: "©", frac12: "½" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function parseHtml(html: string): Block[] {
  const src = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|object|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|object|head)\b[^>]*\/?>/gi, " ");
  const blocks: Block[] = [];
  let text = "";
  let heading: number | null = null;
  let table: { rows: string[][]; headerRow: number | null } | null = null;
  let row: string[] | null = null;
  let cell: string | null = null;
  let rowIsHeader = false;
  const flushText = () => {
    const t = normalizeLine(decodeEntities(text));
    text = "";
    if (!t) return;
    if (heading !== null) blocks.push({ type: "heading", level: heading, text: t });
    else blocks.push({ type: "paragraph", text: t });
  };
  const re = /<\s*(\/?)\s*([a-z][a-z0-9]*)\b[^>]*?(\/?)\s*>|([^<]+)|(<)/gi;
  for (const m of src.matchAll(re)) {
    if (m[4] !== undefined || m[5] !== undefined) {
      const piece = m[4] ?? m[5];
      if (cell !== null) cell += piece; else text += piece;
      continue;
    }
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      if (cell !== null) continue;
      flushText();
      heading = closing ? null : Number(tag[1]);
      continue;
    }
    if (tag === "table") {
      if (!closing) { flushText(); table = { rows: [], headerRow: null }; }
      else if (table) {
        if (table.rows.length) {
          const hi = table.headerRow ?? 0;
          const header = table.rows[hi];
          const rows = table.rows.filter((_, i) => i !== hi);
          if (rows.length) blocks.push({ type: "table", header, rows });
          else blocks.push({ type: "paragraph", text: header.join(" ") });
        }
        table = null;
      }
      continue;
    }
    if (table) {
      if (tag === "tr") {
        if (!closing) { row = []; rowIsHeader = false; }
        else if (row) { if (row.length) { if (rowIsHeader && table.headerRow === null) table.headerRow = table.rows.length; table.rows.push(row); } row = null; }
      } else if (tag === "td" || tag === "th") {
        if (!closing) { cell = ""; if (tag === "th") rowIsHeader = true; }
        else if (cell !== null && row) { row.push(normalizeLine(decodeEntities(cell))); cell = null; }
      } else if (tag === "br" && cell !== null) cell += " ";
      continue;
    }
    if (["p", "div", "li", "br", "ul", "ol", "section", "article", "blockquote", "pre", "dd", "dt", "tr", "body", "main", "footer", "header"].includes(tag)) {
      flushText();
      if (tag === "li" && !closing) text = "• ";
    } else text += " ";
  }
  flushText();
  return blocks;
}

// ── CSV ──────────────────────────────────────────────────────────────────────

/** RFC 4180: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === "\"") { if (s[i + 1] === "\"") { field += "\""; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === "\"" && field === "") quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((c) => normalizeLine(c))).filter((r) => r.some((c) => c !== ""));
}

function parseCsvBlocks(text: string): Block[] {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  if (rows.length === 1) return [{ type: "paragraph", text: rows[0].join(" | ") }];
  return [{ type: "table", header: rows[0], rows: rows.slice(1) }];
}

// ── JSON ─────────────────────────────────────────────────────────────────────

const scalar = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);
const show = (v: unknown) => normalizeLine(v === null ? "null" : String(v));
const label = (k: string) => normalizeLine(k.replace(/[_-]+/g, " "));

function parseJsonBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const walk = (v: unknown, depth: number) => {
    if (Array.isArray(v)) {
      if (v.length && v.every((x) => x && typeof x === "object" && !Array.isArray(x) && Object.values(x).every(scalar))) {
        const keys = [...new Set(v.flatMap((x) => Object.keys(x as object)))];
        blocks.push({ type: "table", header: keys.map(label), rows: v.map((x) => keys.map((k) => ((x as Record<string, unknown>)[k] === undefined ? "" : show((x as Record<string, unknown>)[k])))) });
        return;
      }
      if (v.every(scalar)) { if (v.length) blocks.push({ type: "paragraph", text: v.map(show).join("; ") }); return; }
      for (const x of v) walk(x, depth);
      return;
    }
    if (v && typeof v === "object") {
      const lines: string[] = [];
      const flush = () => { if (lines.length) blocks.push({ type: "paragraph", text: lines.join("; ") }); lines.length = 0; };
      for (const [k, x] of Object.entries(v)) {
        if (scalar(x)) { lines.push(`${label(k)}: ${show(x)}`); continue; }
        flush();
        blocks.push({ type: "heading", level: Math.min(6, depth + 1), text: label(k) });
        walk(x, depth + 1);
      }
      flush();
      return;
    }
    if (scalar(v)) blocks.push({ type: "paragraph", text: show(v) });
  };
  walk(JSON.parse(text), 0);
  return blocks;
}

// ── PDF ──────────────────────────────────────────────────────────────────────

// pdf.js OPS.paintImageXObject, paintInlineImageXObject, paintImageMaskXObject (stable numbers in pdf.js 5).
const IMAGE_OPS = new Set([85, 86, 83]);

type PdfItem = { str: string; x: number; y: number; w: number; h: number };
type PdfLine = { text: string; cells: string[]; h: number; y: number; gapBefore: number; pageHeight: number };

function pdfLines(items: PdfItem[], pageHeight: number): PdfLine[] {
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PdfItem[][] = [];
  for (const it of items) {
    const row = rows.find((r) => Math.abs(r[0].y - it.y) <= Math.max(2, r[0].h / 2));
    if (row) row.push(it); else rows.push([it]);
  }
  rows.sort((a, b) => b[0].y - a[0].y);
  const out: PdfLine[] = [];
  let prevY: number | null = null;
  for (const r of rows) {
    r.sort((a, b) => a.x - b.x);
    const h = Math.max(...r.map((i) => i.h));
    // Cells: a gap wider than two character heights separates columns; a small gap is a space.
    const cells: string[] = [];
    let cur = "";
    r.forEach((it, k) => {
      const gap = k > 0 ? it.x - (r[k - 1].x + r[k - 1].w) : 0;
      if (k > 0 && gap > 2 * it.h) { cells.push(cur); cur = it.str; }
      else cur += (k > 0 && gap > 0.15 * it.h ? " " : "") + it.str;
    });
    cells.push(cur);
    const clean = cells.map((c) => normalizeLine(c.replace(/μ(?=[A-Za-z])/g, "µ"))).filter(Boolean);
    const text = clean.join(" ");
    if (!text) continue;
    out.push({ text, cells: clean, h, y: r[0].y, gapBefore: prevY === null ? 0 : prevY - r[0].y, pageHeight });
    prevY = r[0].y;
  }
  return out;
}

async function parsePdf(bytes: Buffer): Promise<ParsedDocument> {
  const { openPdf, textLayerVerdict } = await import("@/lib/documents/pdfPages");
  let opened;
  try { opened = await openPdf(bytes); } catch { throw new KnowledgeParseError("UNREADABLE"); }
  const { doc, destroy } = opened;
  try {
    if (doc.numPages > KNOWLEDGE_MAX_PAGES) throw new KnowledgeParseError("TOO_MANY_PAGES");
    const raw: PdfLine[][] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items: PdfItem[] = [];
      for (const it of content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
        // pdf.js fills the gap between two runs with a blank item as wide as the gap; it is not text, and would hide a table's columns.
        if (!it.str || !it.str.trim() || !it.transform) continue;
        items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width ?? 0, h: Math.abs(it.height || it.transform[3] || 10) });
      }
      const lines = pdfLines(items, page.getViewport({ scale: 1 }).height);
      const verdict = textLayerVerdict(lines.map((l) => l.text).join("\n"));
      if (verdict === "GARBAGE") throw new KnowledgeParseError("NO_TEXT_LAYER");
      if (verdict === "EMPTY") {
        // A blank or divider page is skipped; a page that paints an image and has no text is a scan, and refuses the file.
        const ops = await page.getOperatorList();
        if (ops.fnArray.some((op) => IMAGE_OPS.has(op))) throw new KnowledgeParseError("NO_TEXT_LAYER");
      }
      raw.push(lines);
      page.cleanup();
    }
    // Running headers, footers and page numbers live in a page's top or bottom band (EDGE_BAND of its height):
    // only lines there are candidates, so a body line that repeats on every page (a dosing step) is kept.
    const edge = (ls: PdfLine[]) => new Set(ls.filter((l) => l.y >= l.pageHeight * (1 - EDGE_BAND) || l.y <= l.pageHeight * EDGE_BAND));
    const furniture = repeatedLines(raw.map((ls) => [...edge(ls)].map((l) => l.text)));
    const allHeights = raw.flat().map((l) => l.h).sort((a, b) => a - b);
    const body = allHeights.length ? allHeights[Math.floor(allHeights.length / 2)] : 10;
    const pages: ParsedPage[] = raw.map((lines, i) => {
      const e = edge(lines);
      return { pageNumber: i + 1, blocks: pdfBlocks(lines.filter((l) => !(e.has(l) && (furniture.has(furnitureKey(l.text)) || isPageNumberLine(l.text)))), body) };
    });
    return { pages, pageCount: doc.numPages };
  } finally {
    await destroy();
  }
}

function pdfBlocks(lines: PdfLine[], body: number): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let table: string[][] = [];
  const flushPara = () => {
    if (!para.length) return;
    // A word hyphenated across lines is joined; a number range never is.
    blocks.push({ type: "paragraph", text: normalizeText(para.join("\n")).replace(/\n/g, " ") });
    para = [];
  };
  const flushTable = () => {
    if (table.length >= 2) blocks.push({ type: "table", header: table[0], rows: table.slice(1) });
    else if (table.length === 1) para.push(table[0].join(" "));
    table = [];
  };
  for (const l of lines) {
    if (l.cells.length >= 2 && (!table.length || l.cells.length === table[0].length)) { flushPara(); table.push(l.cells); continue; }
    flushTable();
    const big = l.h >= body * 1.2;
    const level = headingLevelOf(l.text);
    if ((big && l.text.length <= 90 && !/[.;,]$/.test(l.text)) || (level !== null && /^\d/.test(l.text))) {
      flushPara();
      blocks.push({ type: "heading", level: level ?? (l.h >= body * 1.6 ? 1 : 2), text: l.text });
      continue;
    }
    if (para.length && l.gapBefore > l.h * 1.8) flushPara();
    para.push(l.text);
  }
  flushTable();
  flushPara();
  return blocks;
}
