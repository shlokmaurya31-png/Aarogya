/**
 * Flagship 2b — one consumer registry (src/lib/runner/consumers.ts), loaded by
 * every entry point, and no event marked processed for part of it.
 *
 *   1. The dispatcher refuses to run while any consumer of the registry is
 *      not registered in its process; a pending event stays pending.
 *   2. With the registry registered, an event is PROCESSED only with a
 *      PROCESSED delivery for every consumer the registry lists for its type.
 *   3. Entry points: the worker (`--once`), POST /api/cron/tick and the
 *      platform dispatch route each report exactly the registry's consumers.
 *   4. Statically: nothing in src/ registers a consumer outside the registry,
 *      and every file that dispatches events registers the whole registry
 *      (or goes through runTick, which does).
 *
 * Usage: through `npm run verify:all` (builds the app itself; --no-build reuses one).
 */
import "./lib/gateBootstrap";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/db";
import { emitDomainEvent } from "../src/lib/events/emit";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { ConsumerRegistryIncompleteError, declaredConsumerRegistry, getConsumerNames, requiredConsumersFor, resetConsumers } from "../src/lib/events/consumers";
import { CONSUMER_REGISTRY, EXPECTED_CONSUMERS, registerAllConsumers } from "../src/lib/runner/consumers";
import { startServer, loginAs } from "./lib/appServer";
import { tag } from "./lib/shareFixture";

const ROOT = path.resolve(__dirname, "..");
const EXPECTED: string[] = [...EXPECTED_CONSUMERS].sort();
let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const diff = (got: string[]) => `missing: ${EXPECTED.filter((n) => !got.includes(n)).join(",") || "none"}; extra: ${got.filter((n) => !EXPECTED.includes(n)).join(",") || "none"}`;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p, out); }
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

async function main() {
  // The registry itself: one list, names unique, the names the code expects.
  const names = CONSUMER_REGISTRY.map((c) => c.name);
  report("The registry lists every expected consumer once", same(names, EXPECTED) && new Set(names).size === names.length, diff(names));
  report("The registry declared itself to the dispatcher", same((declaredConsumerRegistry() ?? []).map((c) => c.name), EXPECTED));

  // 1. A partial registry refuses to dispatch, and the event stays pending.
  const org = await prisma.organization.findFirstOrThrow({ select: { id: true } });
  const canary = `cr-${tag}`;
  const emit = (id: string) => emitDomainEvent(prisma, { type: "InvoiceCreated", aggregateId: id, organizationId: org.id, correlationId: `crgate:${id}`, payload: { invoiceId: id, totalMinor: 100, currency: "INR" } });
  await emit(`${canary}-1`);
  resetConsumers(); // only the built-in projection now
  let refused: unknown = null;
  try { await dispatchPendingDomainEvents({ batchSize: 50 }); } catch (e) { refused = e; }
  report("With part of the registry, the dispatcher refuses to run", refused instanceof ConsumerRegistryIncompleteError, refused instanceof Error ? refused.message.slice(0, 140) : "it ran");
  const stillPending = await prisma.domainEventOutbox.findFirst({ where: { aggregateId: `${canary}-1` }, select: { status: true } });
  report("…and the event it would have taken is still pending", stillPending?.status === "PENDING", stillPending?.status);

  // 2. The whole registry: PROCESSED, with a delivery for every listed consumer.
  registerAllConsumers();
  report("registerAllConsumers registers exactly the registry", same(getConsumerNames(), EXPECTED), diff(getConsumerNames()));
  for (let i = 0; i < 40; i++) {
    await dispatchPendingDomainEvents({ batchSize: 500, maxDurationMs: 30_000 });
    const e = await prisma.domainEventOutbox.findFirst({ where: { aggregateId: `${canary}-1` }, select: { status: true } });
    if (e?.status !== "PENDING" && e?.status !== "RETRY" && e?.status !== "PROCESSING") break;
  }
  const evt = await prisma.domainEventOutbox.findFirstOrThrow({ where: { aggregateId: `${canary}-1` }, select: { eventId: true, status: true, eventType: true } });
  const required = requiredConsumersFor(evt.eventType, declaredConsumerRegistry() ?? []);
  const delivered = (await prisma.domainEventDelivery.findMany({ where: { eventId: evt.eventId, status: "PROCESSED" }, select: { consumerName: true } })).map((d) => d.consumerName);
  report("With the whole registry the event is PROCESSED", evt.status === "PROCESSED", evt.status);
  report("…with a processed delivery for every consumer the registry lists for its type", required.length > 0 && required.every((n) => delivered.includes(n)), `${required.length} required: ${required.filter((n) => !delivered.includes(n)).join(",") || "all delivered"}`);

  // 4. Statically.
  const src = walk(path.join(ROOT, "src"));
  const registering = src.filter((f) => /\bregisterConsumer\(/.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f));
  report("Nothing in src/ registers a consumer outside the registry", same(registering, ["src/lib/events/consumers.ts", "src/lib/runner/consumers.ts"]), registering.join(", "));
  const dispatchers = [...src, path.join(ROOT, "scripts", "worker.ts")].filter((f) => {
    const t = readFileSync(f, "utf8");
    return /\bdispatchPendingDomainEvents\(/.test(t) && !/function dispatchPendingDomainEvents/.test(t);
  });
  const partial = dispatchers.filter((f) => !/\b(registerAllConsumers|runTick)\(/.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f));
  report("Every file that dispatches registers the whole registry (or uses runTick)", partial.length === 0, partial.join(", ") || `${dispatchers.length} dispatching files`);

  // 3a. The worker.
  const w = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsx"), ["scripts/worker.ts", "--once"], { cwd: ROOT, env: process.env, encoding: "utf8", timeout: 120_000 });
  let workerConsumers: string[] = [];
  try { workerConsumers = (JSON.parse(w.stdout.trim().split("\n").pop() ?? "{}") as { consumers?: string[] }).consumers ?? []; } catch { /* reported below */ }
  report("The worker's consumers are the registry", same(workerConsumers, EXPECTED), w.status === 0 ? diff(workerConsumers) : (w.stderr || w.stdout).slice(-400));

  // 3b, 3c. The app: the cron tick and the platform dispatch route.
  const secret = randomBytes(32).toString("hex");
  const { base, child, serverLog } = await startServer({ CRON_SECRET: secret });
  try {
    const cron = await fetch(base + "/api/cron/tick", { method: "POST", headers: { authorization: `Bearer ${secret}` } });
    const cronJson = (await cron.json().catch(() => ({}))) as { consumers?: string[] };
    report("POST /api/cron/tick's consumers are the registry", cron.status === 200 && same(cronJson.consumers ?? [], EXPECTED), `HTTP ${cron.status}; ${diff(cronJson.consumers ?? [])}`);
    const cookie = await loginAs(base, "admin@demo.aarogya", "Scholar@123");
    const d = await fetch(base + "/api/hospital/enterprise/events/dispatch", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ batchSize: 10 }) });
    const dJson = (await d.json().catch(() => ({}))) as { consumers?: string[] };
    report("The platform dispatch route's consumers are the registry", d.status === 200 && same(dJson.consumers ?? [], EXPECTED), `HTTP ${d.status}; ${diff(dJson.consumers ?? [])}`);
  } catch (e) {
    console.error(`The app's log (last lines):\n${serverLog().slice(-2000)}`);
    throw e;
  } finally {
    child.kill("SIGTERM");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  await prisma.$disconnect();
  if (fail > 0) process.exit(1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
