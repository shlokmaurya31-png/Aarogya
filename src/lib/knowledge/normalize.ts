/**
 * RAG Phase 2, step 2.4 — normalisation and noise removal for knowledge text.
 *
 * normalizeText never drops a letter, digit, unit or sign: it composes
 * Unicode (NFC), turns the many space characters into one space, removes
 * invisible characters that are not text (soft hyphen, zero-width space,
 * byte-order mark) — keeping the zero-width (non-)joiner, which is part of
 * Telugu and Kannada words — and joins a word hyphenated across a line break
 * ("dia-⏎betes"), never a number ("10-⏎20" stays). Medicine names, doses,
 * numbers and dates are never changed. A property test holds this.
 *
 * Noise removal is separate and only for paged documents: a line repeated on
 * most pages (a running header or footer) and a bare page number ("Page 3 of
 * 10", "- 3 -") are page furniture, not content.
 */
const INVISIBLE = /[­​⁠﻿]/gu;
const SPACES = /[\t   -   　]+/gu;

export function normalizeText(s: string): string {
  return s
    .normalize("NFC")
    .replace(INVISIBLE, "")
    .replace(/\r\n?/g, "\n")
    .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
    .replace(SPACES, " ")
    .replace(/ *\n */g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** One line of text, its internal line breaks joined by spaces. */
export function normalizeLine(s: string): string {
  return normalizeText(s).replace(/\n+/g, " ");
}

const PAGE_NUMBER = /^(?:page\s*)?[-–—]?\s*\d{1,4}\s*[-–—]?(?:\s*(?:of|\/)\s*\d{1,4})?$/iu;

export function isPageNumberLine(line: string): boolean {
  return PAGE_NUMBER.test(line.trim());
}

/**
 * The lines that repeat on at least half the pages of a document of three or
 * more pages (compared with their digits blanked, so "Page 2" and "Page 3"
 * are one line): running headers and footers.
 */
export function repeatedLines(pages: readonly (readonly string[])[]): Set<string> {
  const out = new Set<string>();
  if (pages.length < 3) return out;
  const key = (l: string) => l.trim().toLowerCase().replace(/\d+/g, "#");
  const counts = new Map<string, number>();
  for (const lines of pages) for (const k of new Set(lines.map(key).filter((k) => k.length > 0))) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const [k, n] of counts) if (n >= Math.max(3, Math.ceil(pages.length / 2))) out.add(k);
  return out;
}

export function furnitureKey(line: string): string {
  return line.trim().toLowerCase().replace(/\d+/g, "#");
}
