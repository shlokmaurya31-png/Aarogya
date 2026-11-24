import type { AnswerSentence } from "@/lib/ai/record/types";
import { NLEM_2022 } from "@/lib/medicines/nlem2022";
import { expandEntry } from "@/lib/medicines/reference";
import { INN_STARTER } from "@/lib/medicines/innStarter";
import { canonicalMedicine, MEDICINE_VARIANTS } from "./medicineNames";
import { LEXICON } from "./lexicon";

/**
 * Week 4b — every sentence is checked before anyone sees it
 * (docs/RAG_DESIGN.md §8.2, §9.4):
 *   - a FACT cites at least one source, and every citation names a source the
 *     retrieval returned;
 *   - every number in a FACT occurs in the original text (or context line) of a
 *     source it cites — never from a translation, never rounded;
 *   - a GUIDANCE line cites nothing and states no number (the emergency
 *     number 112 excepted).
 *   - RAG Phase 5, step 5.5: every unit written after a number in a FACT is
 *     the unit that number carries in a cited source ("11.2 mg/dL" against a
 *     source's "11.2 g/dL" fails; "500 mcg" against "500 mg" fails), or, for a
 *     number written bare (a range's end), a unit on the same source line;
 *     every medicine a FACT names is named by a cited source (as its INN, a
 *     variant, or the lexicon concept's name in any script): a renamed
 *     medicine fails though its dose is in the source.
 * The first sentence that fails stops a staff answer there (sentences
 * before it were already released); a patient answer is withheld whole.
 */
export interface SourceText { n: number; text: string; context: string }

export type SentenceCheck = { ok: true } | { ok: false; reason: "NO_CITATION" | "UNKNOWN_CITATION" | "NUMBER_NOT_IN_SOURCE" | "UNIT_NOT_IN_SOURCE" | "MEDICINE_NOT_IN_SOURCE" | "GUIDANCE_WITH_FACTS" };

/** Numbers as written (decimals, ranges' ends, dates' parts), normalized: "1,000" → "1000", "07" → "7". */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/,(?=\d{3}\b)/g, "").replace(/^0+(?=\d)/, ""));
}

/** Units as a clinical answer writes them, longest first; matched right after a number. */
const UNITS = ["µiu/ml", "miu/l", "iu/ml", "mmol/l", "meq/l", "mg/dl", "g/dl", "ng/ml", "pg/ml", "µg/ml", "mcg/ml", "mg/ml", "u/l", "iu/l", "ml/kg", "mg/kg", "mcg/kg", "ml/hr", "ml/h", "breaths/min", "beats/min", "/min", "/µl", "/mm3", "mmhg", "cells/µl",
  "mcg", "µg", "mg", "kg", "g", "ml", "l", "iu", "units", "unit", "%", "°c", "°f", "psi", "puffs", "puff", "tablets", "tablet", "drops", "drop", "hours", "hour", "days", "day", "weeks", "week"];
const UNIT_SYNONYM: Record<string, string> = { "µg": "mcg", "µg/ml": "mcg/ml", unit: "units", tablet: "tablets", puff: "puffs", drop: "drops", hour: "hours", day: "days", week: "weeks", "ml/h": "ml/hr", "beats/min": "/min", "breaths/min": "/min" };
const UNIT_AFTER = new RegExp(`(\\d+(?:[.,]\\d+)*)\\s*(${UNITS.map((u) => u.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "giu");

/** Each number written with a unit right after it: [number (normalized), unit (normalized)]. */
export function unitsIn(text: string): [string, string][] {
  return [...text.matchAll(UNIT_AFTER)].map((m) => {
    const n = m[1].replace(/,(?=\d{3}\b)/g, "").replace(/^0+(?=\d)/, "");
    const u = m[2].toLowerCase();
    return [n, UNIT_SYNONYM[u] ?? u];
  });
}

/**
 * Names on the medicine lists that are also lab analytes, gases or plain words ("Potassium 5.6 mEq/L" is a result;
 * "oxygen saturation" a vital): never checked as medicines, so a result's sentence isn't failed for them.
 */
const NOT_A_MEDICINE_WORD = new Set(["oxygen", "glucose", "dextrose", "lithium", "calcium", "sodium", "potassium", "magnesium", "iron", "zinc", "albumin", "water", "saline", "valerate", "condom", "denatured", "soluble", "surfactant", "caffeine", "glycerin", "glycerine", "alcohol", "ethanol", "iodine", "charcoal", "vitamin", "thiamine"]);

let medicineIndex: Map<string, string> | null = null;
/**
 * Every medicine name the app knows, lower case, to its concept: the INN (NLEM 2022, the INN starter list, the variants
 * table) or the lexicon concept's id, so a name in one script or spelling and its INN in another are the same medicine.
 */
function medicines(): Map<string, string> {
  if (medicineIndex) return medicineIndex;
  const m = new Map<string, string>();
  for (const n of [...NLEM_2022.flatMap(expandEntry), ...INN_STARTER]) { const w = n.toLowerCase().normalize("NFC"); if (/^[a-z][a-z-]{3,}$/.test(w)) m.set(w, canonicalMedicine(w) ?? w); }
  for (const [inn, vs] of Object.entries(MEDICINE_VARIANTS)) { m.set(inn, inn); for (const v of vs) if (!v.includes(" ")) m.set(v, inn); }
  for (const c of LEXICON.filter((x) => x.kind === "MEDICINE")) {
    const inn = c.names.en?.[0]?.toLowerCase() ?? c.id;
    for (const ns of Object.values(c.names)) for (const n of ns!) { const w = n.toLowerCase().normalize("NFC"); if (!w.includes(" ") && [...w].length >= 3) m.set(w, canonicalMedicine(w) ?? inn); }
  }
  for (const w of NOT_A_MEDICINE_WORD) m.delete(w);
  medicineIndex = m;
  return m;
}

/** The medicines a text names, as concepts (INN where one is known). */
export function medicinesIn(text: string): Set<string> {
  const idx = medicines();
  const out = new Set<string>();
  for (const w of text.toLowerCase().normalize("NFC").split(/[^\p{L}\p{M}\p{N}‌‍-]+/u)) {
    const c = idx.get(w) ?? idx.get(w.replace(/-+$/, ""));
    if (c) out.add(c);
  }
  return out;
}

export function checkSentence(s: AnswerSentence, sources: Map<number, SourceText>): SentenceCheck {
  if (s.kind === "GUIDANCE") {
    return s.citations.length || numbersIn(s.text).some((n) => n !== "112") ? { ok: false, reason: "GUIDANCE_WITH_FACTS" } : { ok: true };
  }
  if (!s.citations.length) return { ok: false, reason: "NO_CITATION" };
  const cited = s.citations.map((n) => sources.get(n));
  if (cited.some((c) => !c)) return { ok: false, reason: "UNKNOWN_CITATION" };
  const citedText = cited.map((c) => `${c!.context}\n${c!.text}`).join("\n");
  const available = new Set(numbersIn(citedText));
  if (!numbersIn(s.text).every((n) => available.has(n))) return { ok: false, reason: "NUMBER_NOT_IN_SOURCE" };
  // A unit after a number must be one that number carries in a cited source, or, for a number a source line writes
  // without a unit (a reference range's end: "12.0 - 15.5"), a unit on that same line. Never a unit from another line:
  // a number that only happens to occur elsewhere (a title's, a date's) can't lend a dose its unit.
  const lines = citedText.split("\n");
  for (const [n, u] of unitsIn(s.text)) {
    const ok = lines.some((line) => {
      const withUnits = unitsIn(line);
      if (withUnits.some(([sn, su]) => sn === n && su === u)) return true;
      return !withUnits.some(([sn]) => sn === n) && numbersIn(line).includes(n) && withUnits.some(([, su]) => su === u);
    });
    if (!ok) return { ok: false, reason: "UNIT_NOT_IN_SOURCE" };
  }
  const named = medicinesIn(citedText);
  for (const med of medicinesIn(s.text)) if (!named.has(med)) return { ok: false, reason: "MEDICINE_NOT_IN_SOURCE" };
  return { ok: true };
}
