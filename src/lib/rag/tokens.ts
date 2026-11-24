/**
 * RAG Phase 4, steps 4.1 and 4.3 — token counting per provider family
 * (docs/RAG_ARCHITECTURE.md §11.1). No single tokenizer is assumed: each
 * provider family has its own estimator, and each is corrected per language
 * from what the provider reports.
 *
 *   anthropic  the answer models (Claude): input and output tokens
 *   voyage     the embedding and rerank provider
 *   mock-hash  the offline embeddings (counted like voyage, so usage is
 *              never reported as zero on the mock)
 *
 * The estimate is per script: characters of each script divided by that
 * family's characters per token, words never counted below one token each.
 * Indic scripts take far more tokens per character than Latin text; the old
 * estimate (a quarter of the characters, chunk.ts) undercounted them about
 * threefold.
 *
 * Calibration (4.3): `calibrate()` takes (estimate, reported) pairs per
 * language and returns a factor per language (the median ratio). With real
 * providers the pairs come from provider-reported usage; with mocks, from
 * the fixed reference table (tokenReference.ts), which is a byte-level proxy
 * and PENDING REPLACEMENT by provider-reported counts once a key is in use.
 * No text leaves the process to count it.
 */
export type TokenFamily = "anthropic" | "voyage" | "mock-hash";
export type Script = "latin" | "devanagari" | "bengali" | "gurmukhi" | "gujarati" | "oriya" | "tamil" | "telugu" | "kannada" | "malayalam" | "arabic" | "other";

const RANGES: [number, number, Script][] = [
  [0x0900, 0x097f, "devanagari"], [0x0980, 0x09ff, "bengali"], [0x0a00, 0x0a7f, "gurmukhi"], [0x0a80, 0x0aff, "gujarati"],
  [0x0b00, 0x0b7f, "oriya"], [0x0b80, 0x0bff, "tamil"], [0x0c00, 0x0c7f, "telugu"], [0x0c80, 0x0cff, "kannada"],
  [0x0d00, 0x0d7f, "malayalam"], [0x0600, 0x06ff, "arabic"], [0x0750, 0x077f, "arabic"], [0xfb50, 0xfdff, "arabic"], [0xfe70, 0xfeff, "arabic"],
];

export function scriptOf(cp: number): Script {
  if (cp < 0x0250) return "latin";
  for (const [lo, hi, s] of RANGES) if (cp >= lo && cp <= hi) return s;
  return "other";
}

/** Characters per token, per family and script (before the per-language correction). */
const CHARS_PER_TOKEN: Record<TokenFamily, Record<Script, number>> = {
  anthropic: { latin: 3.6, devanagari: 1.5, bengali: 1.4, gurmukhi: 1.4, gujarati: 1.4, oriya: 1.2, tamil: 1.3, telugu: 1.3, kannada: 1.3, malayalam: 1.2, arabic: 2.0, other: 1.0 },
  voyage: { latin: 4.0, devanagari: 2.0, bengali: 1.9, gurmukhi: 1.9, gujarati: 1.9, oriya: 1.7, tamil: 1.8, telugu: 1.8, kannada: 1.8, malayalam: 1.7, arabic: 2.4, other: 1.2 },
  "mock-hash": { latin: 4.0, devanagari: 2.0, bengali: 1.9, gurmukhi: 1.9, gujarati: 1.9, oriya: 1.7, tamil: 1.8, telugu: 1.8, kannada: 1.8, malayalam: 1.7, arabic: 2.4, other: 1.2 },
};

/** The uncorrected estimate: per-script characters over that script's rate, at least one token per word. */
export function baseTokens(text: string, family: TokenFamily): number {
  if (!text) return 0;
  const rates = CHARS_PER_TOKEN[family];
  let t = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x20 || cp === 0x0a) continue;
    t += 1 / rates[scriptOf(cp)];
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(words, Math.ceil(t));
}

/** The dominant script of a text (by characters, spaces and digits ignored), as a language key for the correction. */
export function dominantScript(text: string): Script {
  const n = new Map<Script, number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x40) continue;
    const s = scriptOf(cp);
    n.set(s, (n.get(s) ?? 0) + 1);
  }
  let best: Script = "latin", most = 0;
  for (const [s, k] of n) if (k > most) { best = s; most = k; }
  return best;
}

/** A correction per script: estimate × factor ≈ what the provider reports. 1 where nothing is known. */
export type Calibration = Partial<Record<Script, number>>;

/** Per script, the median of reported ÷ base estimate over the samples. */
export function calibrate(samples: readonly { text: string; reported: number }[], family: TokenFamily): Calibration {
  const by = new Map<Script, number[]>();
  for (const s of samples) {
    const base = baseTokens(s.text, family);
    if (!base || !s.reported) continue;
    const k = dominantScript(s.text);
    by.set(k, [...(by.get(k) ?? []), s.reported / base]);
  }
  const out: Calibration = {};
  for (const [k, r] of by) {
    const sorted = [...r].sort((a, b) => a - b);
    const m = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    out[k] = Math.round(m * 1000) / 1000;
  }
  return out;
}

let calibrations: Partial<Record<TokenFamily, Calibration>> = {};
/** Installs a calibration (from provider-reported usage, or the reference table with mocks). */
export function setCalibration(family: TokenFamily, c: Calibration | null) {
  calibrations = { ...calibrations, [family]: c ?? undefined };
}

/** The estimate the budget uses: the per-script count, corrected for the text's dominant script. */
export function countTokens(text: string, family: TokenFamily): number {
  const base = baseTokens(text, family);
  const f = calibrations[family]?.[dominantScript(text)] ?? 1;
  return Math.ceil(base * f);
}

/** The family that counts a model's or an embedding space's tokens. */
export function familyFor(provider: string): TokenFamily {
  if (provider === "claude" || provider === "mock" || provider === "extractive" || provider.startsWith("claude-") || provider === "mock-record-1") return "anthropic";
  if (provider === "voyage" || provider.startsWith("voyage-")) return "voyage";
  // Every other embedding space (the offline mock-hash, a self-hosted model) is counted like the mock.
  return "mock-hash";
}
