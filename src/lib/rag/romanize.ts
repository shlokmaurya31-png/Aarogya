/**
 * RAG Phase 3, step 3.9 (plan §13.3 decision C, a) — deterministic, rule-based
 * romanisation of the app's Indic scripts, and transliteration of a Latin
 * word into them. No model.
 *
 * The scheme is a simplified ISO 15919 written in plain ASCII, the way people
 * type Indian words on a phone keyboard: aspirates as "kh", "gh"…, retroflex
 * and dental stops alike ("t", "d"), vowel length dropped ("ā" → "a"), the
 * nasal marks as "n", the inherent vowel written "a" and dropped at the end
 * of a word in the scripts whose languages drop it (Devanagari, Bengali,
 * Gujarati). A Latin query is normalised to the same skeleton
 * (latinSkeleton: "ee" → "i", "oo" → "u", "aa" → "a", "w" → "v"…), so
 * "neerizhivu" and the romanised "நீரிழிவு" meet as "nirizhivu".
 *
 * The Brahmic blocks share one layout (ISCII), so one table by offset serves
 * Devanagari, Bengali, Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada and
 * Malayalam, with each script's own letters added. Urdu is written without
 * most vowels; its romanisation is a consonant skeleton with ی and و read as
 * vowels between consonants.
 *
 * Rules written from the scripts' standard tables and checked on the
 * development word list (romanize.test.ts), never on the Indic benchmark.
 * PENDING NATIVE-SPEAKER REVIEW.
 */
export type IndicScript = "Devanagari" | "Bengali" | "Gurmukhi" | "Gujarati" | "Oriya" | "Tamil" | "Telugu" | "Kannada" | "Malayalam" | "Arabic";

const BLOCKS: [IndicScript, number][] = [["Devanagari", 0x0900], ["Bengali", 0x0980], ["Gurmukhi", 0x0a00], ["Gujarati", 0x0a80], ["Oriya", 0x0b00], ["Tamil", 0x0b80], ["Telugu", 0x0c00], ["Kannada", 0x0c80], ["Malayalam", 0x0d00]];
/** Scripts whose languages drop a word-final inherent vowel in speech (Hindi, Marathi, Bengali, Gujarati). */
const DROP_FINAL_A = new Set<IndicScript>(["Devanagari", "Bengali", "Gujarati", "Gurmukhi"]);

const VOWELS: Record<number, string> = { 0x05: "a", 0x06: "a", 0x07: "i", 0x08: "i", 0x09: "u", 0x0a: "u", 0x0b: "ri", 0x0c: "li", 0x0d: "e", 0x0e: "e", 0x0f: "e", 0x10: "ai", 0x11: "o", 0x12: "o", 0x13: "o", 0x14: "au", 0x60: "ri", 0x61: "li" };
const CONSONANTS: Record<number, string> = {
  0x15: "k", 0x16: "kh", 0x17: "g", 0x18: "gh", 0x19: "n", 0x1a: "ch", 0x1b: "chh", 0x1c: "j", 0x1d: "jh", 0x1e: "n",
  0x1f: "t", 0x20: "th", 0x21: "d", 0x22: "dh", 0x23: "n", 0x24: "t", 0x25: "th", 0x26: "d", 0x27: "dh", 0x28: "n", 0x29: "n",
  0x2a: "p", 0x2b: "ph", 0x2c: "b", 0x2d: "bh", 0x2e: "m", 0x2f: "y", 0x30: "r", 0x31: "r", 0x32: "l", 0x33: "l", 0x34: "zh", 0x35: "v",
  0x36: "sh", 0x37: "sh", 0x38: "s", 0x39: "h",
  0x58: "k", 0x59: "kh", 0x5a: "g", 0x5b: "z", 0x5c: "r", 0x5d: "rh", 0x5e: "f", 0x5f: "y",
};
const SIGNS: Record<number, string> = { 0x3e: "a", 0x3f: "i", 0x40: "i", 0x41: "u", 0x42: "u", 0x43: "ri", 0x44: "ri", 0x45: "e", 0x46: "e", 0x47: "e", 0x48: "ai", 0x49: "o", 0x4a: "o", 0x4b: "o", 0x4c: "au", 0x62: "li", 0x63: "li" };
const VIRAMA = 0x4d;
const NASAL = new Set([0x01, 0x02]);
const VISARGA = 0x03;
/** Letters outside the shared layout, per script. */
const EXTRA: Record<number, { c?: string; v?: string; sign?: string }> = {
  0x09dc: { c: "r" }, 0x09dd: { c: "rh" }, 0x09df: { c: "y" }, 0x09f0: { c: "r" }, 0x09f1: { c: "v" }, 0x09ce: { v: "t" },
  0x0b5c: { c: "r" }, 0x0b5d: { c: "rh" }, 0x0b5f: { c: "y" }, 0x0b71: { c: "v" },
  0x0d7a: { v: "n" }, 0x0d7b: { v: "n" }, 0x0d7c: { v: "r" }, 0x0d7d: { v: "l" }, 0x0d7e: { v: "l" }, 0x0d7f: { v: "k" }, 0x0d4e: { v: "r" },
  0x0bd7: { sign: "" }, 0x0c55: { sign: "" }, 0x0c56: { sign: "" }, 0x0cd5: { sign: "" }, 0x0cd6: { sign: "" }, 0x0d57: { sign: "u" },
};

const URDU: Record<string, string> = {
  "ا": "a", "آ": "a", "ب": "b", "پ": "p", "ت": "t", "ٹ": "t", "ث": "s", "ج": "j", "چ": "ch", "ح": "h", "خ": "kh", "د": "d", "ڈ": "d", "ذ": "z", "ر": "r", "ڑ": "r",
  "ز": "z", "ژ": "zh", "س": "s", "ش": "sh", "ص": "s", "ض": "z", "ط": "t", "ظ": "z", "ع": "", "غ": "gh", "ف": "f", "ق": "k", "ک": "k", "ك": "k", "گ": "g", "ل": "l",
  "م": "m", "ن": "n", "ں": "n", "ہ": "h", "ه": "h", "ة": "h", "ھ": "h", "ء": "", "ئ": "y", "ے": "e", "ۓ": "e",
};

export function scriptOf(ch: string): IndicScript | null {
  const cp = ch.codePointAt(0)!;
  for (const [s, base] of BLOCKS) if (cp >= base && cp < base + 0x80) return s;
  if (cp >= 0x0600 && cp <= 0x06ff) return "Arabic";
  return null;
}

/** Tamil and Malayalam romanise the dental stop as "th" by convention (த, ത); elsewhere it is typed "t". */
const DENTAL_TH = new Set<IndicScript>(["Tamil", "Malayalam"]);

function romanizeBrahmic(word: string, script: IndicScript, base: number): string {
  let out = "";
  let pendingA = false;
  for (const ch of word) {
    const cp = ch.codePointAt(0)!;
    const off = cp - base;
    const extra = EXTRA[cp];
    if (extra?.c !== undefined || CONSONANTS[off] !== undefined && off >= 0 && off < 0x80) {
      if (pendingA) out += "a";
      out += extra?.c ?? (off === 0x24 && DENTAL_TH.has(script) ? "th" : CONSONANTS[off]);
      pendingA = true;
    } else if (off === VIRAMA) {
      pendingA = false;
    } else if (extra?.sign !== undefined || SIGNS[off] !== undefined) {
      out += extra?.sign ?? SIGNS[off];
      pendingA = false;
    } else if (extra?.v !== undefined || VOWELS[off] !== undefined) {
      if (pendingA) out += "a";
      out += extra?.v ?? VOWELS[off];
      pendingA = false;
    } else if (NASAL.has(off)) {
      if (pendingA) out += "a";
      out += "n";
      pendingA = false;
    } else if (off === VISARGA) {
      if (pendingA) out += "a";
      out += "h";
      pendingA = false;
    } else if (off >= 0x66 && off <= 0x6f) {
      if (pendingA) out += "a";
      out += String(off - 0x66);
      pendingA = false;
    }
    // Nukta, avagraha, length marks and joiners add nothing.
  }
  if (pendingA && !DROP_FINAL_A.has(script)) out += "a";
  return out;
}

function romanizeUrdu(word: string): string {
  const chars = [...word.replace(/[ً-ٰٟ]/g, "")];
  let out = "";
  chars.forEach((ch, i) => {
    if (ch === "و") out += i === 0 ? "v" : "o";
    else if (ch === "ی" || ch === "ي") out += i === 0 ? "y" : i === chars.length - 1 ? "i" : "i";
    else out += URDU[ch] ?? "";
  });
  return out;
}

/** One word romanised (lower-case ASCII), or the word unchanged if it has no Indic letter. */
export function romanizeWord(word: string): string {
  const w = word.normalize("NFC");
  const first = [...w].find((c) => scriptOf(c));
  if (!first) return w.toLowerCase();
  const script = scriptOf(first)!;
  if (script === "Arabic") return romanizeUrdu(w);
  const base = BLOCKS.find(([s]) => s === script)![1];
  return romanizeBrahmic(w, script, base);
}

/** A text's Indic words romanised; Latin words and numbers kept as they are. Null when the text has no Indic letter. */
export function romanizeText(text: string): string | null {
  if (![...text].some((c) => scriptOf(c))) return null;
  return text.split(/[^\p{L}\p{M}\p{N}‌‍]+/u).filter(Boolean).map((w) => latinSkeleton(romanizeWord(w))).filter(Boolean).join(" ");
}

/** A Latin word as the romanisation skeleton (length and common spelling variants folded). */
export function latinSkeleton(word: string): string {
  return word.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]/g, "")
    .replace(/ee/g, "i").replace(/oo/g, "u").replace(/aa/g, "a").replace(/ii/g, "i").replace(/uu/g, "u")
    .replace(/ph/g, "f").replace(/w/g, "v").replace(/q/g, "k").replace(/x/g, "ks").replace(/c(?!h)/g, "k").replace(/([a-z])\1+/g, "$1");
}

// ── Latin → Indic (query time) ──────────────────────────────────────────────

const L_CONS: [string, number][] = [
  ["chh", 0x1b], ["kh", 0x16], ["gh", 0x18], ["ch", 0x1a], ["jh", 0x1d], ["th", 0x25], ["dh", 0x27], ["ph", 0x2b], ["bh", 0x2d], ["sh", 0x36], ["zh", 0x34],
  ["k", 0x15], ["g", 0x17], ["j", 0x1c], ["t", 0x24], ["d", 0x26], ["n", 0x28], ["p", 0x2a], ["b", 0x2c], ["m", 0x2e], ["y", 0x2f], ["r", 0x30], ["l", 0x32],
  ["v", 0x35], ["w", 0x35], ["s", 0x38], ["h", 0x39], ["f", 0x2b], ["z", 0x1c], ["q", 0x15], ["c", 0x15],
];
const L_VOW: [string, number, number | null][] = [
  // [latin, independent vowel offset, sign offset (null: the inherent vowel)]
  ["aa", 0x06, 0x3e], ["ai", 0x10, 0x48], ["au", 0x14, 0x4c], ["ee", 0x08, 0x40], ["ii", 0x08, 0x40], ["oo", 0x0a, 0x42], ["uu", 0x0a, 0x42],
  ["a", 0x05, null], ["i", 0x07, 0x3f], ["u", 0x09, 0x41], ["e", 0x0f, 0x47], ["o", 0x13, 0x4b],
];
/** Tamil has no separate aspirates or voiced stops: they fold to the plain letter. */
const TAMIL_FOLD: Record<number, number> = { 0x16: 0x15, 0x17: 0x15, 0x18: 0x15, 0x1b: 0x1a, 0x1c: 0x1a, 0x1d: 0x1a, 0x20: 0x1f, 0x21: 0x1f, 0x22: 0x1f, 0x25: 0x24, 0x26: 0x24, 0x27: 0x24, 0x2b: 0x2a, 0x2c: 0x2a, 0x2d: 0x2a, 0x36: 0x37 };

/** A Latin word written in a Brahmic script, letter by letter (greedy, longest match). Approximate by design. */
export function transliterateLatin(word: string, script: Exclude<IndicScript, "Arabic">): string {
  const base = BLOCKS.find(([s]) => s === script)![1];
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  let out = "";
  let i = 0;
  let afterConsonant = false;
  const cons = (off: number) => String.fromCodePoint(base + (script === "Tamil" ? TAMIL_FOLD[off] ?? off : off));
  while (i < w.length) {
    const c = L_CONS.find(([l]) => w.startsWith(l, i));
    if (c) {
      if (afterConsonant) out += String.fromCodePoint(base + VIRAMA);
      out += cons(c[1]);
      afterConsonant = true;
      i += c[0].length;
      continue;
    }
    const v = L_VOW.find(([l]) => w.startsWith(l, i));
    if (v) {
      const final = i + v[0].length === w.length;
      // A word-final "a" after a consonant is written long where the language drops the inherent vowel (so it is read).
      if (afterConsonant) { const sign = v[2] ?? (final && DROP_FINAL_A.has(script) ? 0x3e : null); if (sign !== null) out += String.fromCodePoint(base + sign); }
      else out += String.fromCodePoint(base + v[1]);
      afterConsonant = false;
      i += v[0].length;
      continue;
    }
    i += 1;
  }
  // A final consonant carries no vowel: written with the virama where the language would otherwise read one.
  if (afterConsonant && !DROP_FINAL_A.has(script)) out += String.fromCodePoint(base + VIRAMA);
  return out;
}

/** The Brahmic scripts a Latin query is transliterated into (Urdu is matched through the romanised shadow text). */
export const QUERY_SCRIPTS: Exclude<IndicScript, "Arabic">[] = ["Devanagari", "Bengali", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam"];
