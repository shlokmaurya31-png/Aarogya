import { CHUNK, estimateTokens, sentences } from "@/lib/rag/chunk";
import type { Block, ParsedDocument } from "./parse";

/**
 * RAG Phase 2, step 2.4 — hierarchical chunking of a knowledge document.
 *
 *   - The heading stack is the section path ("4 Dosing > 4.2 Children"); a new
 *     heading at or above the current level ends the chunk, so a chunk never
 *     spans two sections.
 *   - Paragraphs accumulate to about 400 tokens (at most 512); a paragraph
 *     longer than that is split between sentences, never inside one.
 *   - A table is its own chunk, kept whole with its header, up to
 *     TABLE_MAX_TOKENS; a longer table is split between rows and every part
 *     repeats the header, so no row is ever read without its columns.
 *   - Every chunk carries the page it starts on (PDF) and its section path,
 *     for the citation.
 * Deterministic: the same document always gives the same chunks.
 */
export const TABLE_MAX_TOKENS = 1200;

export interface KnowledgeChunk {
  text: string;
  heading: string | null;
  sectionPath: string | null;
  pageNumber: number | null;
  tokenCount: number;
  kind: "TEXT" | "TABLE";
}

export function tableText(header: string[], rows: string[][]): string {
  const line = (r: string[]) => `| ${r.join(" | ")} |`;
  return [line(header), `|${header.map(() => " --- ").join("|")}|`, ...rows.map(line)].join("\n");
}

export function chunkKnowledge(doc: ParsedDocument): KnowledgeChunk[] {
  const out: KnowledgeChunk[] = [];
  const stack: { level: number; text: string }[] = [];
  let buf: string[] = [];
  let bufTokens = 0;
  let bufPage: number | null = null;
  const path = () => (stack.length ? stack.map((h) => h.text).join(" > ") : null);
  const heading = () => (stack.length ? stack[stack.length - 1].text : null);
  const push = (text: string, page: number | null, kind: KnowledgeChunk["kind"]) => out.push({ text, heading: heading(), sectionPath: path(), pageNumber: page, tokenCount: estimateTokens(text), kind });
  const flush = () => {
    if (buf.length) push(buf.join("\n\n"), bufPage, "TEXT");
    buf = [];
    bufTokens = 0;
    bufPage = null;
  };
  const addText = (text: string, page: number | null) => {
    const pieces = estimateTokens(text) <= CHUNK.max ? [text] : splitLong(text);
    for (const piece of pieces) {
      const t = estimateTokens(piece);
      if (buf.length && bufTokens + t > CHUNK.target) flush();
      if (!buf.length) bufPage = page;
      buf.push(piece);
      bufTokens += t;
    }
  };
  const addTable = (b: Extract<Block, { type: "table" }>, page: number | null) => {
    flush();
    if (estimateTokens(tableText(b.header, b.rows)) <= TABLE_MAX_TOKENS) return push(tableText(b.header, b.rows), page, "TABLE");
    let part: string[][] = [];
    for (const row of b.rows) {
      if (part.length && estimateTokens(tableText(b.header, [...part, row])) > TABLE_MAX_TOKENS) { push(tableText(b.header, part), page, "TABLE"); part = []; }
      part.push(row);
    }
    if (part.length) push(tableText(b.header, part), page, "TABLE");
  };

  for (const page of doc.pages) {
    for (const b of page.blocks) {
      if (b.type === "heading") {
        flush();
        while (stack.length && stack[stack.length - 1].level >= b.level) stack.pop();
        stack.push({ level: b.level, text: b.text });
      } else if (b.type === "table") addTable(b, page.pageNumber);
      else addText(b.text, page.pageNumber);
    }
  }
  flush();
  return out;
}

/** A paragraph over the maximum, split between sentences (a single over-long sentence is its own piece). */
function splitLong(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of sentences(text)) {
    const next = cur ? `${cur} ${s}` : s;
    if (cur && estimateTokens(next) > CHUNK.target) { out.push(cur); cur = s; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}
