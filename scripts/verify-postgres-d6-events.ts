/**
 * PHASE D6 — domain-event foundation gate (transactional guarantee + concurrency
 * + security + reliability).
 *
 * Verifies: the transactional outbox (commit ⇒ event, rollback ⇒ no event),
 * at-least-once delivery with idempotent consumers, retry + dead-letter, poison
 * isolation, controlled replay, tenant isolation + platform-only operations, and
 * the six mandated race conditions. Concurrency races run only on PostgreSQL
 * (SQLite serialises writers) and are checked sequentially there for correctness.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-d6-events.ts
 */
import { prisma } from "../src/lib/db";
import { emitDomainEvent } from "../src/lib/events/emit";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerConsumer, unregisterConsumer, type DomainEventConsumer } from "../src/lib/events/consumers";
import { replayEvent, retryDeadLetter } from "../src/lib/events/replay";
import { getEventMetrics, listEvents, getEvent, listDeadLetters, listOrganizationEvents } from "../src/lib/events/ops";
import { PermanentEventError, RetryableEventError } from "../src/lib/events/types";
import { loadActorMemberships, type ActorMemberships } from "../src/lib/auth/tenantContext";

const IS_PG = /^postgres/i.test(process.env.DATABASE_URL ?? "");
let pass = 0, fail = 0; const failures: string[] = [];
const ok = (l: string) => { pass++; console.log(`  ✓ ${l}`); };
const bad = (l: string, d?: string) => { fail++; failures.push(l + (d ? ` — ${d}` : "")); console.log(`  ✗ ${l}${d ? ` — ${d}` : ""}`); };
async function expectDeny(l: string, fn: () => Promise<unknown>, status?: number) {
  try { await fn(); bad(l, "expected denial but SUCCEEDED"); }
  catch (e) { const s = (e as { status?: number }).status; if (status && s !== status) bad(l, `denied ${s}, expected ${status}`); else ok(l); }
}

const ID = { orgA: "d6t-org-a", orgB: "d6t-org-b", facA: "d6t-fac-a", facB: "d6t-fac-b", uPlatform: "d6t-u-plat", uAdminA: "d6t-u-admin-a", uAdminB: "d6t-u-admin-b", uOutsider: "d6t-u-out" };

// ── Controllable test consumer ───────────────────────────────────────────────
const invocations = new Map<string, number>();
let poisonPayloads = new Set<string>(); // aggregateIds whose consumer throws permanently
let flakyDown = false; // when true, aggregateIds in flakyAggregates fail with a retryable error
let flakyAggregates = new Set<string>();
const testConsumer: DomainEventConsumer = {
  name: "d6-gate-consumer",
  handles: "*",
  async handle(e) {
    invocations.set(e.eventId, (invocations.get(e.eventId) ?? 0) + 1);
    if (poisonPayloads.has(e.aggregateId)) throw new PermanentEventError("poison", "GATE_POISON");
    if (flakyDown && flakyAggregates.has(e.aggregateId)) throw new RetryableEventError("temporarily down", "GATE_FLAKY");
  },
};

async function drain() {
  // Advance `now` far past any backoff so RETRY events are eligible; loop to quiescence.
  const now = new Date(Date.now() + 30 * 86_400_000);
  for (let i = 0; i < 30; i++) {
    const r = await dispatchPendingDomainEvents({ batchSize: 200, maxDurationMs: 20_000, now });
    if (r.claimed === 0) break;
  }
}
const invocationsFor = (eventId: string) => invocations.get(eventId) ?? 0;

async function cleanupEvents() {
  await prisma.domainEventOutbox.deleteMany({ where: { OR: [{ organizationId: { in: [ID.orgA, ID.orgB] } }, { correlationId: { startsWith: "d6gate:" } }] } });
}
async function cleanup() {
  await cleanupEvents();
  const userIds = Object.values(ID);
  await prisma.auditEvent.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.collectionActivity.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.billingReconciliationException.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.organizationMembership.deleteMany({ where: { OR: [{ organizationId: { in: [ID.orgA, ID.orgB] } }, { userId: { in: userIds } }] } });
  await prisma.facility.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ID.orgA, ID.orgB] } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function seed() {
  const mk = (id: string, role: "AAROGYA_ADMIN" | "HOSPITAL_ADMIN" | "DOCTOR") => prisma.user.create({ data: { id, email: `${id}@d6.local`, passwordHash: "x", role, displayName: id } });
  await Promise.all([mk(ID.uPlatform, "AAROGYA_ADMIN"), mk(ID.uAdminA, "HOSPITAL_ADMIN"), mk(ID.uAdminB, "HOSPITAL_ADMIN"), mk(ID.uOutsider, "DOCTOR")]);
  for (const [org, fac, admin] of [[ID.orgA, ID.facA, ID.uAdminA], [ID.orgB, ID.facB, ID.uAdminB]] as const) {
    await prisma.organization.create({ data: { id: org, slug: org, name: org, status: "ACTIVE" } });
    await prisma.facility.create({ data: { id: fac, slug: fac, name: fac, organizationId: org, status: "ACTIVE" } });
    await prisma.organizationMembership.create({ data: { organizationId: org, userId: admin, isAdmin: true, status: "ACTIVE" } });
  }
}

// A catalogued, org-scoped event with an arbitrary aggregateId (outbox has no FK to invoice).
const emitTest = (organizationId: string, aggregateId: string) =>
  emitDomainEvent(prisma, { type: "InvoiceCreated", aggregateId, organizationId, correlationId: `d6gate:${aggregateId}`, payload: { invoiceId: aggregateId, totalMinor: 1000, currency: "INR" } });

async function run() {
  console.log(`\n=== PHASE D6 EVENT GATE (${IS_PG ? "PostgreSQL" : "SQLite"}) ===\n`);
  await cleanup();
  await seed();
  registerConsumer(testConsumer);
  const mPlatform = await loadActorMemberships(ID.uPlatform, "AAROGYA_ADMIN");
  const mAdminA = await loadActorMemberships(ID.uAdminA, "HOSPITAL_ADMIN");
  const mOutsider = await loadActorMemberships(ID.uOutsider, "DOCTOR");

  // ── Transactional guarantee (§15) ──────────────────────────────────────────
  console.log("[transactional outbox]");
  {
    // Success: domain row + event both commit.
    const okId = "d6-txn-ok";
    await prisma.$transaction(async (tx) => {
      await tx.collectionActivity.create({ data: { organizationId: ID.orgA, type: "NOTE", note: okId } });
      await emitDomainEvent(tx, { type: "InvoiceCreated", aggregateId: okId, organizationId: ID.orgA, correlationId: `d6gate:${okId}`, payload: { invoiceId: okId, totalMinor: 1000, currency: "INR" } });
    });
    const hasRow = await prisma.collectionActivity.findFirst({ where: { organizationId: ID.orgA, note: okId } });
    const hasEvt = await prisma.domainEventOutbox.findFirst({ where: { aggregateId: okId } });
    if (hasRow && hasEvt) ok("commit: domain row AND event both persist"); else bad("commit atomicity", `row=${!!hasRow} evt=${!!hasEvt}`);
  }
  {
    // Rollback: neither the domain row nor the event survive.
    const rbId = "d6-txn-rollback";
    await prisma.$transaction(async (tx) => {
      await tx.collectionActivity.create({ data: { organizationId: ID.orgA, type: "NOTE", note: rbId } });
      await emitDomainEvent(tx, { type: "InvoiceCreated", aggregateId: rbId, organizationId: ID.orgA, correlationId: `d6gate:${rbId}`, payload: { invoiceId: rbId, totalMinor: 1000, currency: "INR" } });
      throw new Error("force rollback");
    }).catch(() => {});
    const hasRow = await prisma.collectionActivity.findFirst({ where: { organizationId: ID.orgA, note: rbId } });
    const hasEvt = await prisma.domainEventOutbox.findFirst({ where: { aggregateId: rbId } });
    if (!hasRow && !hasEvt) ok("rollback: neither domain row nor event persist"); else bad("rollback atomicity", `row=${!!hasRow} evt=${!!hasEvt}`);
  }

  // ── Dispatch + delivery + idempotency (§18/§19) ────────────────────────────
  console.log("[dispatch + idempotency]");
  {
    invocations.clear();
    const { eventId } = await emitTest(ID.orgA, "d6-dispatch-1");
    await drain();
    const evt = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId } });
    const del = await prisma.domainEventDelivery.findUnique({ where: { eventId_consumerName: { eventId, consumerName: testConsumer.name } } });
    if (evt.status === "PROCESSED" && del?.status === "PROCESSED" && invocationsFor(eventId) === 1) ok("event dispatched once, delivery PROCESSED, consumer invoked once"); else bad("dispatch", `status=${evt.status} del=${del?.status} inv=${invocationsFor(eventId)}`);
    // Re-dispatch must NOT re-invoke a PROCESSED consumer (idempotent).
    await drain();
    if (invocationsFor(eventId) === 1) ok("re-dispatch does not re-invoke a PROCESSED consumer"); else bad("idempotent re-dispatch", `inv=${invocationsFor(eventId)}`);
  }

  // ── Immutability under processing (§41) ────────────────────────────────────
  console.log("[immutability]");
  {
    const { eventId } = await emitTest(ID.orgA, "d6-immutable");
    const before = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId } });
    await drain();
    const after = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId } });
    const same = before.eventType === after.eventType && before.eventVersion === after.eventVersion && before.occurredAt.getTime() === after.occurredAt.getTime() && JSON.stringify(before.payload) === JSON.stringify(after.payload) && before.organizationId === after.organizationId;
    if (same && after.status === "PROCESSED") ok("business fields immutable across processing (only status/timestamps change)"); else bad("immutability", `same=${same} status=${after.status}`);
  }

  // ── Retry + dead-letter (§16/§30) ──────────────────────────────────────────
  console.log("[retry + dead-letter]");
  {
    invocations.clear();
    poisonPayloads = new Set(["d6-poison-perm"]);
    const { eventId } = await emitTest(ID.orgA, "d6-poison-perm");
    await drain();
    const evt = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId } });
    const del = await prisma.domainEventDelivery.findUnique({ where: { eventId_consumerName: { eventId, consumerName: testConsumer.name } } });
    if (evt.status === "DEAD_LETTER" && del?.status === "DEAD_LETTER" && del?.lastErrorCode === "GATE_POISON") ok("permanent consumer failure → DEAD_LETTER (not retried, not lost)"); else bad("permanent failure", `status=${evt.status} del=${del?.status}/${del?.lastErrorCode}`);
    poisonPayloads = new Set();
  }
  {
    // Retryable failure with maxAttempts=1 dead-letters after the bounded attempts.
    invocations.clear();
    flakyDown = true; flakyAggregates = new Set(["d6-flaky-dl"]);
    const { eventId } = await emitTest(ID.orgA, "d6-flaky-dl");
    await prisma.domainEventOutbox.update({ where: { eventId }, data: { maxAttempts: 1 } });
    await drain();
    const evt = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId } });
    const del = await prisma.domainEventDelivery.findUnique({ where: { eventId_consumerName: { eventId, consumerName: testConsumer.name } } });
    if (evt.status === "DEAD_LETTER" && del?.lastErrorCode === "GATE_FLAKY") ok("retryable failure dead-letters after bounded maxAttempts"); else bad("bounded retry", `status=${evt.status} code=${del?.lastErrorCode}`);
    flakyDown = false; flakyAggregates = new Set();
  }

  // ── Poison isolation (§32) ─────────────────────────────────────────────────
  console.log("[poison isolation]");
  {
    invocations.clear();
    const a = await emitTest(ID.orgA, "d6-iso-A");
    // Insert a schema-poison event directly (unknown type) BETWEEN two valid events.
    const poisonEventId = "d6-iso-POISON";
    await prisma.domainEventOutbox.create({ data: { eventId: poisonEventId, eventType: "NopeEventType", eventVersion: 1, aggregateType: "INVOICE", aggregateId: poisonEventId, organizationId: ID.orgA, correlationId: "d6gate:d6-iso-POISON", payload: { junk: true }, occurredAt: new Date(), status: "PENDING" } });
    const c = await emitTest(ID.orgA, "d6-iso-C");
    await drain();
    const evtA = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId: a.eventId } });
    const evtP = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId: poisonEventId } });
    const evtC = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId: c.eventId } });
    if (evtA.status === "PROCESSED" && evtC.status === "PROCESSED" && evtP.status === "DEAD_LETTER" && evtP.lastErrorCode === "SCHEMA_UNKNOWN") ok("poison event dead-lettered; surrounding valid events still processed"); else bad("poison isolation", `A=${evtA.status} P=${evtP.status}/${evtP.lastErrorCode} C=${evtC.status}`);
  }

  // ── Controlled replay (§29/§69) ────────────────────────────────────────────
  console.log("[replay]");
  {
    invocations.clear();
    const { eventId } = await emitTest(ID.orgA, "d6-replay");
    await drain();
    const firstInv = invocationsFor(eventId);
    const before = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId } });
    await replayEvent(mPlatform, eventId, { reason: "gate" });
    await drain();
    const after = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId } });
    const immutable = before.eventType === after.eventType && JSON.stringify(before.payload) === JSON.stringify(after.payload) && before.occurredAt.getTime() === after.occurredAt.getTime();
    if (firstInv === 1 && invocationsFor(eventId) === 2 && after.status === "PROCESSED" && immutable) ok("replay re-delivers exactly once more and leaves the event immutable"); else bad("replay", `inv=${invocationsFor(eventId)} status=${after.status} immutable=${immutable}`);
    // Replay is audited.
    const audited = await prisma.auditEvent.findFirst({ where: { type: "platform.event.replayed", organizationId: ID.orgA } });
    if (audited) ok("replay is audited"); else bad("replay audit", "no audit event");
  }

  // ── Security (§35/§51) ─────────────────────────────────────────────────────
  console.log("[security]");
  await expectDeny("non-platform cannot read event metrics", () => getEventMetrics(mAdminA), 403);
  await expectDeny("non-platform cannot list the cross-tenant stream", () => listEvents(mAdminA), 403);
  await expectDeny("non-platform cannot list dead letters", () => listDeadLetters(mAdminA), 403);
  await expectDeny("outsider cannot read metrics", () => getEventMetrics(mOutsider), 403);
  {
    const someEvent = await prisma.domainEventOutbox.findFirstOrThrow({ where: { organizationId: ID.orgA } });
    await expectDeny("org admin cannot replay events", () => replayEvent(mAdminA, someEvent.eventId), 403);
    await expectDeny("org admin cannot inspect an arbitrary event", () => getEvent(mAdminA, someEvent.eventId), 403);
  }
  {
    // Tenant isolation: org A admin reading org B's events is 404-shaped denial.
    await emitTest(ID.orgB, "d6-orgB-secret");
    await expectDeny("org A admin cannot read org B events (tenant isolation)", () => listOrganizationEvents(mAdminA, ID.orgB), 404);
    const own = await listOrganizationEvents(mAdminA, ID.orgA);
    if (own.every((e) => e.organizationId === ID.orgA)) ok("org admin reads only its OWN org's events"); else bad("tenant scoping", "leaked another org");
  }
  {
    // Sensitive payload never persisted: emit with a forbidden key is rejected.
    let rejected = false;
    await emitDomainEvent(prisma, { type: "PatientRegistered", aggregateId: "d6-sec", organizationId: ID.orgA, facilityId: ID.facA, payload: { patientId: "p", password: "leak" } as never }).catch(() => { rejected = true; });
    if (rejected) ok("emit rejects a payload carrying a forbidden (sensitive) key"); else bad("sensitive payload", "was accepted");
  }

  // ── Metrics + tenant propagation ───────────────────────────────────────────
  console.log("[metrics + propagation]");
  {
    const metrics = await getEventMetrics(mPlatform);
    if (typeof metrics.byStatus.PROCESSED === "number" && ["HEALTHY", "ATTENTION", "CRITICAL"].includes(metrics.health)) ok(`metrics computed (processed=${metrics.byStatus.PROCESSED}, deadLetters=${metrics.deadLetters}, health=${metrics.health})`); else bad("metrics", JSON.stringify(metrics.byStatus));
  }

  await concurrency(mPlatform);

  unregisterConsumer(testConsumer.name);
  await cleanup();
  console.log(`\n────────────────────`);
  console.log(`RESULT: ${pass} passed, ${fail} failed  (${IS_PG ? "PostgreSQL" : "SQLite"})`);
  if (fail) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

async function concurrency(mPlatform: ActorMemberships) {
  console.log("[concurrency races]");
  if (!IS_PG) { console.log("  · concurrency races skipped (SQLite serialises writers); single-effect proven by the sequential cases above"); return; }

  // Race 1 — two transactions performing the same idempotent domain action.
  {
    const key = "LEAKAGE:STATE_MISMATCH:d6-race1";
    const doAction = () => prisma.$transaction(async (tx) => {
      const created = await tx.billingReconciliationException.create({ data: { source: "LEAKAGE", kind: "STATE_MISMATCH", organizationId: ID.orgA, severity: "HIGH", status: "OPEN", entityType: "test", entityId: "d6-race1", findingKey: key } });
      await emitDomainEvent(tx, { type: "ReconciliationExceptionCreated", aggregateId: created.id, organizationId: ID.orgA, correlationId: "d6gate:race1", payload: { exceptionId: created.id, kind: "STATE_MISMATCH", severity: "HIGH", source: "LEAKAGE" } });
    });
    const results = await Promise.allSettled([doAction(), doAction(), doAction()]);
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    const rows = await prisma.billingReconciliationException.count({ where: { findingKey: key } });
    const evts = await prisma.domainEventOutbox.count({ where: { correlationId: "d6gate:race1" } });
    if (okCount === 1 && rows === 1 && evts === 1) ok("Race 1: one canonical domain effect and exactly one event"); else bad("Race 1", `ok=${okCount} rows=${rows} evts=${evts}`);
  }

  // Race 2 + 3 — two dispatchers claim/process the same event; one effective run.
  {
    invocations.clear();
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await emitTest(ID.orgA, `d6-race2-${i}`)).eventId);
    const now = new Date(Date.now() + 30 * 86_400_000);
    await Promise.all([
      dispatchPendingDomainEvents({ batchSize: 200, now }),
      dispatchPendingDomainEvents({ batchSize: 200, now }),
      dispatchPendingDomainEvents({ batchSize: 200, now }),
    ]);
    await drain();
    const overCounted = ids.filter((id) => invocationsFor(id) !== 1);
    const processed = await prisma.domainEventOutbox.count({ where: { eventId: { in: ids }, status: "PROCESSED" } });
    if (overCounted.length === 0 && processed === ids.length) ok("Race 2/3: concurrent dispatchers process each event exactly once"); else bad("Race 2/3", `overCounted=${overCounted.length} processed=${processed}/${ids.length}`);
  }

  // Race 4 — concurrent replays of one processed event → one extra effect only.
  {
    invocations.clear();
    const { eventId } = await emitTest(ID.orgA, "d6-race4");
    await drain();
    await Promise.allSettled([replayEvent(mPlatform, eventId, { reason: "r1" }), replayEvent(mPlatform, eventId, { reason: "r2" })]);
    await drain();
    if (invocationsFor(eventId) === 2) ok("Race 4: concurrent replays cause exactly one additional effect"); else bad("Race 4", `inv=${invocationsFor(eventId)} (expected 2)`);
  }

  // Race 5 — dead-letter, then retry + manual retry concurrently after the cause is fixed.
  {
    invocations.clear();
    flakyDown = true; flakyAggregates = new Set(["d6-race5"]);
    const { eventId } = await emitTest(ID.orgA, "d6-race5");
    await prisma.domainEventOutbox.update({ where: { eventId }, data: { maxAttempts: 1 } });
    await drain();
    const dl = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId } });
    flakyDown = false; flakyAggregates = new Set(); // cause corrected
    await Promise.allSettled([retryDeadLetter(mPlatform, eventId, { reason: "a" }), retryDeadLetter(mPlatform, eventId, { reason: "b" })]).catch(() => {});
    await drain();
    const after = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId } });
    const del = await prisma.domainEventDelivery.findUnique({ where: { eventId_consumerName: { eventId, consumerName: testConsumer.name } } });
    if (dl.status === "DEAD_LETTER" && after.status === "PROCESSED" && del?.status === "PROCESSED") ok("Race 5: concurrent retry + manual retry converge to one PROCESSED result"); else bad("Race 5", `dl=${dl.status} after=${after.status} del=${del?.status}`);
  }

  // Race 6 — poison event alongside valid events under concurrent dispatch.
  {
    invocations.clear();
    poisonPayloads = new Set(["d6-race6-poison"]);
    const good1 = await emitTest(ID.orgA, "d6-race6-good1");
    await emitTest(ID.orgA, "d6-race6-poison");
    const good2 = await emitTest(ID.orgA, "d6-race6-good2");
    const now = new Date(Date.now() + 30 * 86_400_000);
    await Promise.all([dispatchPendingDomainEvents({ now }), dispatchPendingDomainEvents({ now })]);
    await drain();
    const g1 = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId: good1.eventId } });
    const g2 = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId: good2.eventId } });
    const poison = await prisma.domainEventOutbox.findFirstOrThrow({ where: { aggregateId: "d6-race6-poison" } });
    if (g1.status === "PROCESSED" && g2.status === "PROCESSED" && poison.status === "DEAD_LETTER") ok("Race 6: poison isolated (dead-lettered); valid events processed under concurrency"); else bad("Race 6", `g1=${g1.status} g2=${g2.status} poison=${poison.status}`);
    poisonPayloads = new Set();
  }
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
