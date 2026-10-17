/**
 * Local background worker (workflow spine §3.1): runs runTick in a loop.
 *   npm run worker
 * Sleeps 2 s after a tick with no work, loops immediately when a batch limit
 * was hit, and stops cleanly on SIGINT/SIGTERM after the current tick.
 * Staging and production use POST /api/cron/tick instead (docs/STAGING_SUPABASE.md).
 */
import { prisma } from "../src/lib/db";
import { runTick } from "../src/lib/runner/tick";

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`\n${sig}: finishing the current tick…`);
  });
}

async function main() {
  console.log("worker: started");
  while (!stopping) {
    try {
      const r = await runTick({ budgetMs: 10_000 });
      const did = r.events.claimed + r.workflows.timersFired + r.workflows.instancesRun;
      if (did > 0) {
        console.log(`worker: events ${r.events.processed} processed / ${r.events.retried} retry / ${r.events.deadLettered} dead; workflows ${r.workflows.timersFired} timers, ${r.workflows.instancesRun} instances (${r.durationMs} ms)`);
      }
      if (!r.moreWork) await new Promise((res) => setTimeout(res, did > 0 ? 250 : 2_000));
    } catch (err) {
      console.error("worker: tick failed", err instanceof Error ? err.message : err);
      await new Promise((res) => setTimeout(res, 5_000));
    }
  }
  await prisma.$disconnect();
  console.log("worker: stopped");
}

void main();
