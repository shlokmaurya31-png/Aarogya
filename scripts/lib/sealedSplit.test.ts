import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recordedHashes } from "./sealedHashes";

/**
 * RAG Phase 4 housekeeping — the sealed held-out split stays sealed: only its
 * runner reads it (no gate, no tuning script, no app code), and the file is
 * the one whose hash the benchmark document records.
 */
const ROOT = path.resolve(__dirname, "..", "..");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? (f === "node_modules" ? [] : files(p)) : /\.(ts|tsx|js|mjs)$/.test(f) ? [p] : [];
  });
}

describe("the sealed split", () => {
  it("is read only by scripts/eval-rag-sealed.ts", () => {
    const readers = [...files(path.join(ROOT, "scripts")), ...files(path.join(ROOT, "src")), ...files(path.join(ROOT, "eval"))]
      .filter((f) => !f.endsWith("sealedSplit.test.ts"))
      .filter((f) => /sealed[/\\"', ]+.*phase[45]|phase[45]\.json|"sealed"\s*,\s*"phase[45]/.test(readFileSync(f, "utf8")));
    expect(readers.map((f) => path.relative(ROOT, f))).toEqual(["scripts/eval-rag-sealed.ts"]);
  });
  for (const split of ["phase4", "phase5"]) {
    it(`${split}.json matches the sha-256 recorded for it in docs/RAG_INDIC_BENCHMARK.md`, () => {
      const sha = createHash("sha256").update(readFileSync(path.join(ROOT, "eval", "rag", "sealed", `${split}.json`))).digest("hex");
      expect(recordedHashes(readFileSync(path.join(ROOT, "docs", "RAG_INDIC_BENCHMARK.md"), "utf8"))[split]).toBe(sha);
    });
  }
  it("no sealed question repeats one of the development or test split, or of an earlier sealed split", () => {
    const norm = (s?: string) => (s ?? "").trim().toLowerCase();
    const read = (...p: string[]) => JSON.parse(readFileSync(path.join(ROOT, "eval", "rag", ...p), "utf8")).questions as { ask?: { question?: string } }[];
    const seen = new Set(read("questions.json").map((q) => norm(q.ask?.question)).filter(Boolean));
    for (const split of ["phase4", "phase5"]) {
      const sealed = read("sealed", `${split}.json`);
      expect(sealed.filter((q) => q.ask?.question && seen.has(norm(q.ask.question)))).toEqual([]);
      for (const q of sealed) if (q.ask?.question) seen.add(norm(q.ask.question));
    }
  });
  it("phase5.json covers every answer mode, the eleven languages and at least 15 'no record' questions", () => {
    const qs = JSON.parse(readFileSync(path.join(ROOT, "eval", "rag", "sealed", "phase5.json"), "utf8")).questions as { mode: string; group: string; ask?: { question?: string; language?: string }; expect: { outcome: string } }[];
    expect(new Set(qs.map((q) => q.mode))).toEqual(new Set(["CHART_QA", "KNOWLEDGE_QA", "VISIT_BRIEF", "NURSE_HANDOFF", "EXPLAIN_REPORT", "HEALTH_TIMELINE", "PREVISIT_QUESTIONS"]));
    const script: [string, RegExp][] = [["hi", /[\u0900-\u097F]/], ["bn", /[\u0980-\u09FF]/], ["gu", /[\u0A80-\u0AFF]/], ["or", /[\u0B00-\u0B7F]/], ["ta", /[\u0B80-\u0BFF]/], ["te", /[\u0C00-\u0C7F]/], ["kn", /[\u0C80-\u0CFF]/], ["ml", /[\u0D00-\u0D7F]/], ["ur", /[\u0600-\u06FF]/]];
    const langs = new Set(qs.flatMap((q) => [q.ask?.language, q.group.startsWith("LANG_") ? q.group.slice(5).toLowerCase() : undefined, ...script.filter(([, re]) => re.test(q.ask?.question ?? "")).map(([l]) => l)]).filter(Boolean));
    for (const l of ["en", "hi", "mr", "bn", "ta", "te", "kn", "ml", "gu", "or", "ur"]) expect(langs.has(l), l).toBe(true);
    expect(qs.filter((q) => q.expect.outcome === "NO_RECORD").length).toBeGreaterThanOrEqual(15);
  });
});
