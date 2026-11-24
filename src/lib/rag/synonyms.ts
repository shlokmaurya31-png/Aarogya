/**
 * RAG Phase 5, step 3d — clinical synonyms for the other Phase 4 gaps
 * (docs/RAG_IMPLEMENTATION_PLAN.md §7): the words staff use for critical
 * values, imaging, referrals and pending studies that the record doesn't
 * write. Kept to standard clinical pairs, the record's own words (the
 * indexer's context lines: "Imaging report", "Referral", "critical value")
 * and the development questions; a word that only a held-out or sealed
 * question uses is deliberately left out, though the same team wrote both.
 *
 * Like the abbreviations, a synonym only ADDS search words and counts as the
 * question's subject in the evidence check (abstain.ts); it never rewrites the
 * question or adds a fact. English only for now; the Indic words for these
 * reach the record through the lexicon's test names. Pending clinical review.
 */
export const SYNONYMS: Record<string, string[]> = {
  // Critical values (the instruction for this step: "panic values" = critical values; the lab system writes "critical value").
  panic: ["critical"], "panic value": ["critical value"], "panic values": ["critical value"],
  "critical result": ["critical value"], "critical results": ["critical value"],
  // Imaging: the record says "Imaging report" and the study ("X-ray Chest PA view", "USG abdomen"); dev Q5, D1 ask "X-ray".
  scan: ["imaging"], scans: ["imaging"], radiology: ["imaging"], radiograph: ["x-ray"], ultrasound: ["usg"], sonography: ["usg"],
  // Referrals: the record says "Referral" and the department.
  consultation: ["referral"], "specialist opinion": ["referral"],
  // Pending: the orders reader's word (dev R7 "still pending").
  "not yet done": ["pending"], "yet to be done": ["pending"],
};

const norm = (s: string) => ` ${s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s-]+/gu, " ").replace(/\s+/g, " ").trim()} `;

/** The extra words for a question's synonyms (lower case, single words; none already in the question). */
export function synonymTerms(question: string): string[] {
  const q = norm(question);
  const have = new Set(q.trim().split(" "));
  const out = new Set<string>();
  for (const [phrase, targets] of Object.entries(SYNONYMS)) if (q.includes(` ${phrase} `)) for (const t of targets) for (const w of t.split(/[\s]+/)) if (!have.has(w)) out.add(w);
  return [...out];
}

/** The phrases a word's synonyms stand for, for the evidence check: "panic" → "critical". */
export function synonymForms(word: string, question: string): string[] {
  const q = norm(question);
  return Object.entries(SYNONYMS).filter(([phrase]) => phrase.split(" ").includes(word) && q.includes(` ${phrase} `)).flatMap(([, targets]) => targets);
}
