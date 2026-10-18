/**
 * Week 4a — npm run eval:documents [-- --provider real] [-- --out <file>]
 * (docs/DOCUMENT_PIPELINE_DESIGN.md §10.2).
 *
 * Scores the 50 synthetic samples through the pipeline's own steps and prints
 * a markdown report. Default: the deterministic mocks (the same run as the CI
 * test). `--provider real` uses Claude and is MANUAL: it needs
 * DOCUMENT_AI_PROVIDER=claude and ANTHROPIC_API_KEY, sends only the synthetic
 * fixtures (no person, no database), and is recorded in the PR by hand.
 *
 * Limitation (real run): the fixture PDFs draw Latin-script lines only, with
 * no handwriting fonts or noise, so a real run scores English pages
 * meaningfully and the other scripts not at all until a renderer is added
 * (docs/PRE_LAUNCH_CHECKLIST.md). Exit code 1 when a target is missed.
 */
import { writeFileSync } from "node:fs";
import { documentProviderKind, getDocumentProviders } from "../src/lib/ai/documents";
import { issuePermit } from "../src/lib/ai/documents/permit";
import { meetsTargets, reportMarkdown, runEvaluation } from "../src/lib/documents/eval";
import { evaluationDictionary } from "../src/lib/documents/steps";

async function main() {
  const args = process.argv.slice(2);
  const real = args.includes("--provider") && args[args.indexOf("--provider") + 1] === "real";
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
  if (real && documentProviderKind() !== "claude") {
    console.error("--provider real needs DOCUMENT_AI_PROVIDER=claude and ANTHROPIC_API_KEY (synthetic fixtures only).");
    process.exit(2);
  }
  const providers = real ? getDocumentProviders() : getDocumentProviders({});
  // A permit for synthetic fixtures only: no Person, no database row is read or written.
  const report = await runEvaluation(providers, issuePermit("evaluation:synthetic-fixtures"), evaluationDictionary());
  const md = reportMarkdown(report, real ? "claude" : "mock");
  if (out) writeFileSync(out, md + "\n");
  console.log(md);
  const v = meetsTargets(report);
  if (!v.ok) {
    console.error(`\nTargets missed: ${v.misses.join("; ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
