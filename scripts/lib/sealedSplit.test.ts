import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

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
      .filter((f) => /sealed[/\\"', ]+.*phase4|phase4\.json|"sealed"\s*,\s*"phase4/.test(readFileSync(f, "utf8")));
    expect(readers.map((f) => path.relative(ROOT, f))).toEqual(["scripts/eval-rag-sealed.ts"]);
  });
  it("matches the sha-256 recorded in docs/RAG_INDIC_BENCHMARK.md", () => {
    const sha = createHash("sha256").update(readFileSync(path.join(ROOT, "eval", "rag", "sealed", "phase4.json"))).digest("hex");
    expect(readFileSync(path.join(ROOT, "docs", "RAG_INDIC_BENCHMARK.md"), "utf8")).toContain(`sealed split sha-256: \`${sha}\``);
  });
  it("shares no question with the development or test split", () => {
    const norm = (s?: string) => (s ?? "").trim().toLowerCase();
    const old = new Set(JSON.parse(readFileSync(path.join(ROOT, "eval", "rag", "questions.json"), "utf8")).questions.map((q: { ask?: { question?: string } }) => norm(q.ask?.question)).filter(Boolean));
    const sealed = JSON.parse(readFileSync(path.join(ROOT, "eval", "rag", "sealed", "phase4.json"), "utf8")).questions as { ask?: { question?: string } }[];
    expect(sealed.filter((q) => q.ask?.question && old.has(norm(q.ask.question)))).toEqual([]);
  });
});
