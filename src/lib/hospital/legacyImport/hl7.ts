/**
 * Flagship 5 — a small, strict HL7 v2 reader for the legacy import (ADT and
 * ORU messages; docs/LEGACY_IMPORT_DESIGN.md §11.2). Refuse, don't guess: a
 * file that isn't HL7 v2 (no MSH, a broken header) is refused whole.
 *
 * Messages are split on MSH; segments on CR, LF or CRLF (MLLP framing bytes
 * are dropped). The separators come from each message's MSH-1 and MSH-2, and
 * escape sequences (\F\ \S\ \T\ \R\ \E\) are decoded.
 */

export class Hl7FormatError extends Error {}

export interface Hl7Segment { name: string; fields: string[][][] }
export interface Hl7Message {
  /** 1-based index of the message in the file. */
  index: number;
  /** MSH-9, e.g. "ADT^A01" or "ORU^R01". */
  type: string;
  /** MSH-10. */
  controlId: string;
  segments: Hl7Segment[];
}

interface Seps { field: string; component: string; repetition: string; escape: string; sub: string }

function unescape(s: string, sep: Seps): string {
  if (!s.includes(sep.escape)) return s;
  const e = sep.escape.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return s.replace(new RegExp(`${e}([FSTRE])${e}`, "g"), (_m, c: string) => ({ F: sep.field, S: sep.component, T: sep.sub, R: sep.repetition, E: sep.escape })[c] ?? "");
}

function splitSegment(line: string, sep: Seps): Hl7Segment {
  const name = line.slice(0, 3);
  if (!/^[A-Z][A-Z0-9]{2}$/.test(name)) throw new Hl7FormatError(`"${line.slice(0, 12)}" is not an HL7 segment.`);
  let raw = line.split(sep.field);
  // MSH-1 is the field separator itself, and MSH-2 the encoding characters: kept as written.
  if (name === "MSH") raw = ["MSH", sep.field, ...raw.slice(1)];
  const fields = raw.map((f, i) => (name === "MSH" && i <= 2 ? [[f]] : f.split(sep.repetition).map((rep) => rep.split(sep.component).map((c) => unescape(c, sep)))));
  return { name, fields };
}

export function parseHl7(text: string): Hl7Message[] {
  const clean = text.replace(/[\x0b\x1c]/g, "").replace(/\r\n?/g, "\n");
  const lines = clean.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
  if (!lines.length || !lines[0].startsWith("MSH")) throw new Hl7FormatError("The file doesn't start with an MSH segment.");
  const out: Hl7Message[] = [];
  let sep: Seps | null = null;
  let current: Hl7Message | null = null;
  for (const line of lines) {
    if (line.startsWith("MSH")) {
      const field = line[3];
      const enc = line.slice(4, 8);
      if (!field || enc.length < 4 || /[A-Za-z0-9]/.test(field + enc)) throw new Hl7FormatError(`Message ${out.length + 1}: the MSH header's separators can't be read.`);
      sep = { field, component: enc[0], repetition: enc[1], escape: enc[2], sub: enc[3] };
      const seg = splitSegment(line, sep);
      current = { index: out.length + 1, type: [comp(seg, 9, 1), comp(seg, 9, 2)].filter(Boolean).join("^"), controlId: comp(seg, 10, 1), segments: [seg] };
      out.push(current);
      continue;
    }
    if (!current || !sep) throw new Hl7FormatError("A segment before any MSH.");
    current.segments.push(splitSegment(line, sep));
  }
  return out;
}

/** Field `f`, repetition `r` (1-based), component `c` (1-based), or "". */
export function comp(seg: Hl7Segment | undefined, f: number, c = 1, r = 1): string {
  return (seg?.fields[f]?.[r - 1]?.[c - 1] ?? "").trim();
}
export function reps(seg: Hl7Segment | undefined, f: number): string[][] {
  return seg?.fields[f] ?? [];
}
export const first = (m: Hl7Message, name: string) => m.segments.find((s) => s.name === name);
export const all = (m: Hl7Message, name: string) => m.segments.filter((s) => s.name === name);

/**
 * An HL7 date/time (YYYY[MM[DD[HHMM[SS[.S]]]]][+/-ZZZZ]) as an instant: with
 * its own offset when it has one, else in the facility's zone. A date only
 * (no time) is midnight. Null when it isn't one exactly.
 */
export function parseHl7Time(raw: string, zoned: (dayKey: string, minuteOfDay: number) => Date): { at: Date; hasTime: boolean } | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(?:(\d{2})(?:\.\d{1,4})?)?)?([+-]\d{4})?$/.exec(raw.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, off] = m;
  const key = `${y}-${mo}-${d}`;
  const check = new Date(`${key}T00:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== key) return null;
  const h = hh ? +hh : 0, min = mi ? +mi : 0, s = ss ? +ss : 0;
  if (h > 23 || min > 59 || s > 59) return null;
  if (off) {
    const sign = off[0] === "-" ? -1 : 1;
    const offMin = sign * (+off.slice(1, 3) * 60 + +off.slice(3, 5));
    return { at: new Date(Date.UTC(+y, +mo - 1, +d, h, min, s) - offMin * 60_000), hasTime: Boolean(hh) };
  }
  return { at: new Date(zoned(key, h * 60 + min).getTime() + s * 1000), hasTime: Boolean(hh) };
}
