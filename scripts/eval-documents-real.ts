/**
 * Week 4b (4a follow-up d) — npm run eval:documents:real
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §10.2; pre-launch item 12).
 *
 * MANUAL, never in CI. Runs the 50 synthetic samples through the real
 * document providers (Claude: OCR, translation, tagging, extraction), each
 * page rendered in its own script with handwriting fonts and noise
 * (src/lib/documents/fixtures/render.ts) and normalized as a phone photo is,
 * and scores them with the pipeline's own steps.
 *
 * Data protection:
 *   - synthetic fixtures only: no Person, no database row is read or written;
 *     every name, number and facility on the pages is invented;
 *   - the real-data switch stays OFF: the run refuses to start if
 *     AI_REAL_DATA_ENABLED=true here (real providers only ever see synthetic
 *     data in this run);
 *   - the key is read from the environment or .env.local and never printed.
 *
 * Without ANTHROPIC_API_KEY it reports that it is ready and sends nothing;
 * with a key the provider refuses (no credit, bad key), it says so after one
 * content-free preflight request and sends nothing else (exit 3).
 * Writes .eval-report/documents-real-<time>.md and .json (scores, models,
 * tokens, latency). Exit 1 when a target is missed.
 *
 * Usage: npm run eval:documents:real [-- --samples id,id] [--input marker-pdf] [--concurrency 4]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { documentProviderKind, getDocumentProviders } from "../src/lib/ai/documents";
import { issuePermit } from "../src/lib/ai/documents/permit";
import { claudeDocumentUsage } from "../src/lib/ai/documents/claude";
import { aiModel } from "../src/lib/ai/models";
import { meetsTargets, reportMarkdown, runEvaluation, type EvalInput } from "../src/lib/documents/eval";
import { FIXTURES } from "../src/lib/documents/fixtures";
import { evaluationDictionary } from "../src/lib/documents/steps";
import { readLocalKeys } from "./lib/localKeys";
import { anthropicPreflight } from "./lib/providerPreflight";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const keys = readLocalKeys(["ANTHROPIC_API_KEY", "AI_REAL_DATA_ENABLED"] as const);
  if (keys.AI_REAL_DATA_ENABLED === "true") {
    console.error("Refusing: AI_REAL_DATA_ENABLED=true here. The real-data switch must stay off; this run is for synthetic fixtures only.");
    process.exit(2);
  }
  if (!keys.ANTHROPIC_API_KEY) {
    console.log("Ready, not run: no ANTHROPIC_API_KEY in the environment or .env.local. Nothing was sent anywhere.");
    return;
  }
  const preflight = await anthropicPreflight(keys.ANTHROPIC_API_KEY, aiModel("ocr"));
  if (preflight !== "OK") {
    const note = `Ready, not run: the key is set but the provider refused the account (${preflight}). No sample was sent.`;
    console.log(note);
    mkdirSync(path.resolve(__dirname, "..", ".eval-report"), { recursive: true });
    writeFileSync(path.resolve(__dirname, "..", ".eval-report", "documents-real-latest.md"), `# Document pipeline evaluation (claude)\n\n- ${new Date().toISOString()}: ${note}\n`);
    process.exit(3);
  }
  const env = { DOCUMENT_AI_PROVIDER: "claude", ANTHROPIC_API_KEY: keys.ANTHROPIC_API_KEY };
  if (documentProviderKind(env) !== "claude") throw new Error("The Claude document providers are not selected.");
  const providers = getDocumentProviders(env);
  const ids = arg("samples")?.split(",").filter(Boolean);
  const fixtures = ids ? FIXTURES.filter((f) => ids.includes(f.id)) : FIXTURES;
  const input = (arg("input") ?? "rendered-image") as EvalInput;
  const concurrency = Number(arg("concurrency") ?? 4);
  console.log(`Real-provider evaluation: ${fixtures.length} synthetic samples, input ${input}, concurrency ${concurrency}. Synthetic fixtures only; the real-data switch is off.`);
  const started = Date.now();
  // A permit for the synthetic fixtures only: no Person, no database.
  const report = await runEvaluation(providers, issuePermit("evaluation:synthetic-fixtures"), evaluationDictionary(), fixtures, input, {
    concurrency, continueOnError: true,
    onSample: (s) => console.log(`  ${s.id.padEnd(16)} ${s.error ? `error ${s.error}` : `${s.correctFields}/${s.expectedFields} fields, ${s.ms} ms`}`),
  });
  const verdict = meetsTargets(report);
  const models = { ocr: aiModel("ocr"), ocr_retry: aiModel("ocr_retry"), translation: aiModel("translation"), extraction: aiModel("extraction"), tagging: aiModel("tagging") };
  const usage = Object.fromEntries(claudeDocumentUsage);
  const pages = report.samples.reduce((n, s) => n + (s.error ? 0 : 1), 0);
  const tokens = [...claudeDocumentUsage.values()].reduce((a, u) => ({ input: a.input + u.inputTokens, output: a.output + u.outputTokens }), { input: 0, output: 0 });
  const md = [
    reportMarkdown(report, "claude"), "",
    "## Run", "",
    `- Date: ${new Date().toISOString()}; wall time ${Math.round((Date.now() - started) / 1000)} s; input ${input}; concurrency ${concurrency}`,
    `- Models: ${Object.entries(models).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    `- Tokens: ${tokens.input} in, ${tokens.output} out (${pages ? Math.round(tokens.input / pages) : 0} in and ${pages ? Math.round(tokens.output / pages) : 0} out per page)`,
    ...Object.entries(usage).map(([m, u]) => `  - ${m}: ${u.calls} calls, ${u.inputTokens} in, ${u.outputTokens} out`),
    `- Targets: ${verdict.ok ? "met" : `missed (${verdict.misses.join("; ")})`}`,
    "- Data: synthetic fixtures only (no Person, no database); the real-data switch was off.",
  ].join("\n");
  const dir = path.resolve(__dirname, "..", ".eval-report");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(path.join(dir, `documents-real-${stamp}.md`), md + "\n");
  writeFileSync(path.join(dir, `documents-real-${stamp}.json`), JSON.stringify({ input, concurrency, models, usage, verdict, report }, null, 2) + "\n");
  writeFileSync(path.join(dir, "documents-real-latest.md"), md + "\n");
  console.log(`\n${md}\n\nWritten to .eval-report/documents-real-${stamp}.md`);
  if (!verdict.ok) process.exit(1);
}

main().catch((err) => {
  // Never print a provider's raw error (it could echo request content); the code only.
  console.error(`Evaluation failed: ${(err as { code?: string }).code ?? (err as Error).name}`);
  process.exit(1);
});
