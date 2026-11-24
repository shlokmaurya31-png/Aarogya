import type { AskResult } from "./ask";

/**
 * Week 4b — scoring one evaluation question (docs/RAG_DESIGN.md §10.2). A
 * question scores only if it is both
 *   correct  the expected outcome; every required value present exactly
 *            (whitespace normalized); nothing forbidden; questions only where
 *            asked
 *   cited    every factual line cites; every citation was retrieved; at least
 *            one citation is of an expected source type; the expected labels
 *            are on the cited lines
 * The CI target on the mocks also counts retrieval: an expected source among
 * what was retrieved (the top 8–12 and the live facts).
 *
 * RAG Phase 5: a false answer is worse than a refusal, so every report counts
 * it on its own. Confidently wrong: an answer where "no record" or a safety
 * refusal was the right outcome, or an answer that states a forbidden value.
 */
export interface EvalQuestion {
  id: string; group: string; actor: string; mode: string;
  /** RAG Phase 3 (rag-eval-v2): the fixture patient (default "main"); the split ("dev" for tuning, "test" held out; RAG Phase 4: "sealed", run once per phase); the language questions' kind. */
  patient?: string; split?: "dev" | "test" | "sealed"; kind?: string;
  ask?: { question?: string; document?: string; language?: string; appointment?: string };
  /** `documents`: the knowledge documents (fixture keys) a knowledge answer must cite and retrieve. */
  expect: { outcome: string; required?: string[]; forbidden?: string[]; sources?: string[]; documents?: string[]; labels?: string[]; questionsOnly?: boolean };
}

export interface QuestionScore { id: string; group: string; correct: boolean; cited: boolean; retrieved: boolean; score: boolean; why: string[]; confidentlyWrong?: boolean }

const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

export function scoreQuestion(q: EvalQuestion, r: AskResult, interaction: { retrievedChunkIds: string[]; citedChunkIds: string[] }, retrievedSourceTypes: string[], documentIds: Record<string, readonly string[]> = {}): QuestionScore {
  const why: string[] = [];
  const answer = norm(r.sentences.map((s) => s.text).join("\n"));
  if (r.outcome !== q.expect.outcome) why.push(`outcome ${r.outcome}, expected ${q.expect.outcome}`);
  for (const v of q.expect.required ?? []) if (!answer.includes(norm(v))) why.push(`missing "${v}"`);
  for (const v of q.expect.forbidden ?? []) if (answer.toLowerCase().includes(norm(v).toLowerCase())) why.push(`forbidden "${v}"`);
  if (q.expect.questionsOnly && !r.sentences.filter((s) => s.kind === "FACT").every((s) => s.text.trim().endsWith("?"))) why.push("not questions only");
  const correct = why.length === 0;
  const confidentlyWrong = r.outcome === "ANSWERED" && (q.expect.outcome !== "ANSWERED" || why.some((w) => w.startsWith("forbidden")));
  const before = why.length;
  const facts = r.sentences.filter((s) => s.kind === "FACT");
  if (facts.some((s) => s.citations.length === 0)) why.push("an uncited factual line");
  if (!interaction.citedChunkIds.every((id) => interaction.retrievedChunkIds.includes(id))) why.push("a citation that wasn't retrieved");
  const citedTypes = new Set(r.citations.map((c) => c.sourceType));
  if (q.expect.sources?.length && !q.expect.sources.some((t) => citedTypes.has(t))) why.push(`no citation of ${q.expect.sources.join("/")}`);
  // RAG Phase 3: a knowledge answer must cite the right document, not just any document.
  if (q.expect.documents?.length && !r.citations.some((c) => q.expect.documents!.some((k) => (documentIds[k] ?? []).includes(c.sourceId)))) why.push(`no citation of ${q.expect.documents.join("/")}`);
  const labels = new Set(facts.flatMap((s) => s.labels));
  for (const l of q.expect.labels ?? []) if (!labels.has(l as never)) why.push(`label "${l}" missing`);
  const cited = why.length === before;
  const wanted = q.expect.documents?.length ? q.expect.documents.map((k) => `KD:${k}`) : q.expect.sources ?? [];
  const retrieved = q.expect.outcome !== "ANSWERED" || !wanted.length || wanted.some((t) => retrievedSourceTypes.includes(t));
  return { id: q.id, group: q.group, correct, cited, retrieved, score: correct && cited, why, confidentlyWrong };
}
