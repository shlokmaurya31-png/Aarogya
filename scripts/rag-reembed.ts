/**
 * Week 4b — npm run rag:reembed -- --model <id> --version <n> [--provider mock|voyage] [--dims n] [--batch 200] [--activate --by <userId>]
 * (docs/RAG_DESIGN.md §5.8). Starts (or resumes) building an embedding space,
 * embeds every ACTIVE chunk into it in batches, reports coverage, and, with
 * --activate, switches to it at 100% (audited). The runner also advances
 * spaces being built, a batch per tick. No schema change at any step.
 */
import { prisma } from "../src/lib/db";
import { activateEmbeddingSpace, embeddingCoverage, reembedBatch, startReembed } from "../src/lib/rag/reembed";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const model = arg("model"), version = Number(arg("version") ?? 1), provider = arg("provider") ?? "mock";
  const dims = Number(arg("dims") ?? (model?.match(/(\d+)$/)?.[1] ?? 1024));
  if (!model) throw new Error("--model is required.");
  const space = await startReembed({ embeddingModel: model, embeddingVersion: version, provider, dims, byUserId: arg("by") ?? null });
  for (;;) {
    const r = await reembedBatch({ spaceId: space.id, batchSize: Number(arg("batch") ?? 200) });
    console.log(`embedded ${r.embedded}, removed ${r.removed}, remaining ${r.remaining}`);
    if (r.remaining === 0 || (r.embedded === 0 && r.removed === 0)) break;
  }
  const cov = await embeddingCoverage(space.id);
  console.log(`coverage ${(cov.ratio * 100).toFixed(1)}% (${cov.embedded}/${cov.activeChunks})`);
  if (process.argv.includes("--activate")) {
    const by = arg("by");
    if (!by) throw new Error("--activate needs --by <userId> (the switch is audited).");
    await activateEmbeddingSpace({ spaceId: space.id, byUserId: by });
    console.log(`active: ${model} v${version}`);
  }
}

main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err instanceof Error ? err.message : err); await prisma.$disconnect(); process.exit(1); });
