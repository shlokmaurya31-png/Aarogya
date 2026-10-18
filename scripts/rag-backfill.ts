/**
 * Week 4b — npm run rag:backfill -- --facility <id> [--since <yyyy-mm-dd>] [--batch 100] [--pause 200] [--restart]
 * (docs/RAG_DESIGN.md §5.7): indexes a facility's existing record with the
 * rag-indexer's own function, resumably (a cursor per source type), and
 * refuses a facility the real-data switch doesn't allow. Emits no events.
 */
import { prisma } from "../src/lib/db";
import { backfillFacility } from "../src/lib/rag/backfill";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const facilityId = arg("facility");
  if (!facilityId) throw new Error("--facility is required.");
  const r = await backfillFacility({ facilityId, since: arg("since") ? new Date(arg("since")!) : undefined, batchSize: Number(arg("batch") ?? 100), pauseMs: Number(arg("pause") ?? 200), restart: process.argv.includes("--restart") });
  console.log(`seen ${r.seen}, indexed ${r.indexed}`, r.byType);
}

main().then(() => prisma.$disconnect()).catch(async (err) => { console.error(err instanceof Error ? err.message : err); await prisma.$disconnect(); process.exit(1); });
