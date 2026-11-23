/**
 * RAG Phase 3, step 3.5 — canonical medicine names (docs/RAG_ARCHITECTURE.md
 * §6.3): the international non-proprietary name (WHO INN, as NLEM uses it)
 * and the other names the same medicine is written under in India (the
 * older British names, US names). A chunk that names any of them gets the
 * canonical name as an extra index term (its shadow text), and a query
 * naming any of them is expanded with the others. Pending pharmacist review.
 */
export const MEDICINE_VARIANTS: Record<string, string[]> = {
  paracetamol: ["acetaminophen"], salbutamol: ["albuterol"], adrenaline: ["epinephrine"], noradrenaline: ["norepinephrine"], furosemide: ["frusemide"],
  lidocaine: ["lignocaine"], glibenclamide: ["glyburide"], pethidine: ["meperidine"], amoxicillin: ["amoxycillin"], cefalexin: ["cephalexin"],
  ciclosporin: ["cyclosporine", "cyclosporin"], rifampicin: ["rifampin"], aciclovir: ["acyclovir"], sulfamethoxazole: ["sulphamethoxazole"],
  phenobarbital: ["phenobarbitone"], levothyroxine: ["thyroxine", "eltroxin"], colecalciferol: ["cholecalciferol"], ergocalciferol: ["calciferol"],
  bendroflumethiazide: ["bendrofluazide"], chlorphenamine: ["chlorpheniramine"], dicycloverine: ["dicyclomine"], mesalazine: ["mesalamine"],
  oxetacaine: ["oxethazaine"], hydroxycarbamide: ["hydroxyurea"], glyceryl: ["nitroglycerin"], amphotericin: ["amphotericin b"],
  ondansetron: [], metformin: [], amlodipine: [], atorvastatin: [], azithromycin: [], ceftriaxone: [], insulin: [], omeprazole: [], pantoprazole: [],
  aspirin: ["acetylsalicylic acid"], ibuprofen: [], metronidazole: [], doxycycline: [], warfarin: [], heparin: [], enoxaparin: [], clopidogrel: [],
};

const TO_CANONICAL = new Map<string, string>();
for (const [inn, vs] of Object.entries(MEDICINE_VARIANTS)) { TO_CANONICAL.set(inn, inn); for (const v of vs) TO_CANONICAL.set(v, inn); }

/** The canonical (INN) name for a word, if it names a listed medicine. */
export function canonicalMedicine(word: string): string | null {
  return TO_CANONICAL.get(word.toLowerCase()) ?? null;
}

/** Every listed medicine named in a text, as its canonical name (for a chunk's index terms). */
export function canonicalMedicinesIn(text: string): string[] {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z]+/)) { const c = TO_CANONICAL.get(w); if (c) out.add(c); }
  return [...out];
}

/** A query's medicine words, each expanded with the canonical name and its variants (lower case; none already present). */
export function medicineTerms(words: readonly string[]): string[] {
  const have = new Set(words.map((w) => w.toLowerCase()));
  const out = new Set<string>();
  for (const w of have) {
    const c = TO_CANONICAL.get(w);
    if (!c) continue;
    for (const x of [c, ...MEDICINE_VARIANTS[c]]) for (const part of x.split(/\s+/)) if (!have.has(part)) out.add(part);
  }
  return [...out];
}
