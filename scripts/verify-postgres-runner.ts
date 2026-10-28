/**
 * Workflow spine §3 (phase B step 1): the background runner.
 *
 *   1. Events emitted in one transaction get strictly increasing seq in
 *      emission order, even with an identical occurredAt (occurredAt is
 *      domain time from the app clock: it can tie, and clocks across
 *      instances aren't ordered, so it never orders delivery).
 *   2. Per-aggregate order: with 4 concurrent dispatchers, one aggregate's
 *      events are handled in seq order and never overlap; other aggregates
 *      run alongside.
 *   3. SKIP LOCKED: 30 events across aggregates, 4 concurrent dispatchers,
 *      each event handled exactly once.
 *   4. Head-of-line: an aggregate's event waiting to retry holds back its
 *      successors; once it succeeds they follow. A dead-lettered event no
 *      longer blocks.
 *   5. Reaper: an event abandoned in PROCESSING is reclaimed and delivered.
 *   6. runTick registers every consumer itself (incl. the workflow engine).
 *   7. POST /api/cron/tick: 503 without CRON_SECRET, 401 with a wrong one,
 *      200 with the right one.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-runner.ts
 */
import "./lib/gateBootstrap";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { prisma } from "../src/lib/db";
import { emitDomainEvent } from "../src/lib/events/emit";
import { dispatchPendingDomainEvents, STALE_CLAIM_MS } from "../src/lib/events/dispatcher";
import { registerConsumer, unregisterConsumer } from "../src/lib/events/consumers";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { PermanentEventError, RetryableEventError, type DomainEventEnvelope } from "../src/lib/events/types";
import { runTick } from "../src/lib/runner/tick";
import { EXPECTED_CONSUMERS } from "../src/lib/runner/consumers";
import { POST as cronTick } from "../src/app/api/cron/tick/route";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

// A probe consumer that records what it handled, in order, with timing.
type Seen = { eventId: string; aggregateId: string; start: number; end: number };
const seen: Seen[] = [];
const behaviour = new Map<string, "ok" | "retry-once" | "dead">();
const retried = new Set<string>();
const PROBE = "runner-gate-probe";
const probe = {
  name: PROBE,
  handles: ["PatientRegistered"] as const,
  async handle(e: DomainEventEnvelope) {
    if (!e.aggregateId.startsWith("rg-")) return;
    const b = behaviour.get(e.aggregateId + "|" + e.eventId) ?? "ok";
    if (b === "dead") throw new PermanentEventError("probe: permanent", "PROBE_DEAD");
    if (b === "retry-once" && !retried.has(e.eventId)) {
      retried.add(e.eventId);
      throw new RetryableEventError("probe: try again", "PROBE_RETRY");
    }
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 15));
    seen.push({ eventId: e.eventId, aggregateId: e.aggregateId, start, end: Date.now() });
  },
};

async function main() {
  const run = Date.now().toString(36);
  const facility = await prisma.facility.findUniqueOrThrow({ where: { id: "fac-amc-pune" } });
  const tenant = { organizationId: facility.organizationId, facilityId: facility.id };
  // Flagship 2b: the dispatcher runs only with the whole registry; the probe rides along.
  registerAllConsumers();
  registerConsumer(probe);
  const emitMany = (aggregateId: string, n: number, occurredAt?: Date) =>
    prisma.$transaction(async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        const e = await emitDomainEvent(tx, { type: "PatientRegistered", aggregateId, ...tenant, occurredAt, payload: { patientId: aggregateId } });
        ids.push(e.eventId);
      }
      return ids;
    });
  const rows = (ids: string[]) => prisma.domainEventOutbox.findMany({ where: { eventId: { in: ids } }, orderBy: { seq: "asc" } });
  // Drain everything else first so the probes below run on a quiet queue.
  await dispatchPendingDomainEvents({ batchSize: 500, maxDurationMs: 60_000 });

  // 1. seq within one transaction.
  const tx3 = await emitMany(`rg-${run}-seq`, 3, new Date());
  const r3 = await rows(tx3);
  report("Three events with an identical occurredAt", new Set(r3.map((r) => r.occurredAt.getTime())).size === 1);
  report("…get strictly increasing seq in emission order", r3.map((r) => r.eventId).join() === tx3.join() && r3[0].seq < r3[1].seq && r3[1].seq < r3[2].seq);
  await dispatchPendingDomainEvents({ batchSize: 100 });

  // 2. Per-aggregate order under concurrency.
  seen.length = 0;
  const aggX = `rg-${run}-x`;
  const xs = [...(await emitMany(aggX, 3)), ...(await emitMany(aggX, 3))];
  const others = (await Promise.all([0, 1, 2, 3].map((i) => emitMany(`rg-${run}-o${i}`, 2)))).flat();
  await Promise.all([0, 1, 2, 3].map(() => dispatchPendingDomainEvents({ batchSize: 1, maxDurationMs: 30_000 })));
  const xSeen = seen.filter((s) => s.aggregateId === aggX);
  report("One aggregate's events are handled in seq order across 4 concurrent dispatchers", xSeen.map((s) => s.eventId).join() === xs.join(), `${xSeen.length}/6`);
  const overlap = xSeen.some((s, i) => i > 0 && s.start < xSeen[i - 1].end);
  report("…and never overlap", !overlap);
  report("Other aggregates are handled too (each once)", others.every((id) => seen.filter((s) => s.eventId === id).length === 1));

  // 3. SKIP LOCKED: disjoint claims.
  seen.length = 0;
  const many = (await Promise.all(Array.from({ length: 30 }, (_, i) => emitMany(`rg-${run}-m${i}`, 1)))).flat();
  const results = await Promise.all([0, 1, 2, 3].map(() => dispatchPendingDomainEvents({ batchSize: 5, maxDurationMs: 30_000 })));
  const counts = many.map((id) => seen.filter((s) => s.eventId === id).length);
  report("30 events, 4 concurrent dispatchers: each handled exactly once", counts.every((c) => c === 1), `handled ${counts.filter((c) => c === 1).length}`);
  report("…and the dispatchers took disjoint claims", results.reduce((a, r) => a + r.claimed, 0) >= 30 && results.filter((r) => r.claimed > 0).length >= 2,
    results.map((r) => r.claimed).join("+"));

  // 4. Head-of-line blocking and dead letters.
  seen.length = 0;
  const aggH = `rg-${run}-h`;
  const [h1, h2] = await emitMany(aggH, 2);
  behaviour.set(`${aggH}|${h1}`, "retry-once");
  await dispatchPendingDomainEvents({ batchSize: 50 });
  const [rh1, rh2] = await rows([h1, h2]);
  report("An event waiting to retry holds back its aggregate's next event", rh1.status === "RETRY" && rh2.status === "PENDING", `${rh1.status}/${rh2.status}`);
  await dispatchPendingDomainEvents({ batchSize: 50, now: new Date(Date.now() + 3_600_000) });
  const order = seen.filter((s) => s.aggregateId === aggH).map((s) => s.eventId).join();
  report("…and once it succeeds, the next follows in order", order === [h1, h2].join(), order);

  const aggD = `rg-${run}-d`;
  const [d1, d2] = await emitMany(aggD, 2);
  behaviour.set(`${aggD}|${d1}`, "dead");
  await dispatchPendingDomainEvents({ batchSize: 50 });
  const [rd1, rd2] = await rows([d1, d2]);
  report("A dead-lettered event no longer blocks its successors", rd1.status === "DEAD_LETTER" && rd2.status === "PROCESSED", `${rd1.status}/${rd2.status}`);

  // 5. Reaper.
  const [abandoned] = await emitMany(`rg-${run}-r`, 1);
  await prisma.domainEventOutbox.update({
    where: { eventId: abandoned },
    data: { status: "PROCESSING", claimToken: randomUUID(), lastAttemptAt: new Date(Date.now() - STALE_CLAIM_MS - 60_000) },
  });
  await dispatchPendingDomainEvents({ batchSize: 50 });
  const [ra] = await rows([abandoned]);
  report("An event abandoned in PROCESSING is reclaimed and delivered", ra.status === "PROCESSED", ra.status);
  unregisterConsumer(PROBE);

  // 6. runTick registers every consumer.
  const tick = await runTick({ budgetMs: 20_000 });
  report("runTick registers every consumer itself", EXPECTED_CONSUMERS.every((c) => tick.consumers.includes(c)), tick.consumers.join(","));

  // 7. The cron route.
  const call = (auth?: string) =>
    cronTick(new NextRequest("http://localhost/api/cron/tick", { method: "POST", headers: auth ? { authorization: auth } : {} }));
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  report("Cron route: 503 when CRON_SECRET is unset", (await call("Bearer anything")).status === 503);
  process.env.CRON_SECRET = `gate-${randomUUID()}-${randomUUID()}`;
  report("Cron route: 401 with a wrong secret", (await call("Bearer wrong")).status === 401);
  report("Cron route: 401 with no Authorization header", (await call()).status === 401);
  const okRes = await call(`Bearer ${process.env.CRON_SECRET}`);
  const body = (await okRes.json()) as { ok?: boolean; events?: { claimed: number } };
  report("Cron route: 200 with the right secret, and it ran a tick", okRes.status === 200 && body.ok === true && typeof body.events?.claimed === "number");
  if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved;

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
