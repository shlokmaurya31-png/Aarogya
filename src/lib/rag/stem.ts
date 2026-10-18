/**
 * Week 4b — a deliberately small English suffix stripper for the keyword side
 * of retrieval (Postgres' 'simple' configuration doesn't stem, so a question
 * about being "allergic" missed an "Allergy" entry). Words of six letters or
 * more lose one common suffix and match as a prefix; shorter words, numbers
 * and other scripts are left as they are.
 */
const SUFFIXES = ["ations", "ation", "ities", "ings", "ing", "ies", "ied", "ic", "ed", "es", "s", "y"];

export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length < 6 || !/^[a-z]+$/.test(w)) return w;
  for (const s of SUFFIXES) if (w.endsWith(s) && w.length - s.length >= 5) return w.slice(0, -s.length);
  return w;
}
