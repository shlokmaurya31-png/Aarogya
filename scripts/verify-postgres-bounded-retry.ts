/**
 * Batch 4, decision 5: permanent errors end in FAILED / dead-letter after a
 * bounded number of attempts, and are visible in the dead-letter list.
 *
 *   1. A consumer that hits a missing foreign key (P2003) dead-letters after
 *      DATA_ERROR_ATTEMPTS (3), not the event's 8, with code DATA_P2003, and the
 *      event is in listDeadLetters. Other consumers of the event still process.
 *   2. A workflow SLA timer whose escalation hits a missing parent fails at
 *      once (NOT_FOUND is permanent): timer FAILED, instance FAILED, listed by
 *      listWorkflowDeadLetters; later ticks never retry it.
 *   3. A RUNNING instance whose worker died is reaped: back to RUNNABLE while it
 *      has attempts left, FAILED (and listed) once it has none.
 *   4. The tenancy sweep's fixture rows never enter the queues: no RUNNABLE or
 *      RUNNING instance and no PENDING / RETRY event in its facility.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-bounded-retry.ts
 */
import "./lib/gateBootstrap";
import { prisma } from "../src/lib/db";
import { emitDomainEvent } from "../src/lib/events/emit";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import { registerConsumer, unregisterConsumer } from "../src/lib/events/consumers";
import { DATA_ERROR_ATTEMPTS } from "../src/lib/events/types";
import { listDeadLetters } from "../src/lib/events/ops";
import { tickWorkflows } from "../src/lib/workflows/engine";
import { listWorkflowDeadLetters } from "../src/lib/workflows/ops";
import { LIMITS } from "../src/lib/workflows/types";
import { registerAllConsumers } from "../src/lib/runner/consumers";
import { loadActorMemberships } from "../src/lib/auth/tenantContext";

let pass = 0;
let fail = 0;
function report(name: string, ok: boolean, detail?: string) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

async function main() {
  const run = Date.now().toString(36);
  const facilityId = "fac-amc-pune";
  const fac = await prisma.facility.findUniqueOrThrow({ where: { id: facilityId }, select: { organizationId: true } });
  const admin = await prisma.user.findFirstOrThrow({ where: { role: "AAROGYA_ADMIN" }, orderBy: { id: "asc" } });
  const platform = await loadActorMemberships(admin.id, "AAROGYA_ADMIN");

  // ── 1. A consumer hitting a missing foreign key ─────────────────────────────
  const marker = `bounded-${run}`;
  let calls = 0;
  registerAllConsumers();
  registerConsumer({
    name: "bounded-retry-probe",
    handles: ["PatientRegistered"],
    async handle(e) {
      if (e.aggregateId !== marker) return;
      calls += 1;
      // A real P2003: a task in a facility that does not exist.
      await prisma.task.create({ data: { facilityId: `no-such-facility-${run}`, title: "probe", type: "GENERAL", source: "MANUAL" } });
    },
  });
  const { eventId } = await emitDomainEvent(prisma, {
    type: "PatientRegistered", aggregateId: marker, organizationId: fac.organizationId, facilityId, payload: { patientId: marker },
  });
  for (let i = 0; i < 10; i++) {
    // Simulate the backoff elapsing: the event is due again at once.
    await prisma.domainEventOutbox.updateMany({ where: { eventId, status: "RETRY" }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await dispatchPendingDomainEvents({ batchSize: 100 });
    const st = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId }, select: { status: true } });
    if (st.status === "DEAD_LETTER" || st.status === "PROCESSED") break;
  }
  unregisterConsumer("bounded-retry-probe");
  const evt = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId }, select: { status: true, maxAttempts: true } });
  const probe = await prisma.domainEventDelivery.findUniqueOrThrow({ where: { eventId_consumerName: { eventId, consumerName: "bounded-retry-probe" } } });
  report(`A missing foreign key dead-letters after ${DATA_ERROR_ATTEMPTS} attempts, not the event's ${evt.maxAttempts}`,
    evt.status === "DEAD_LETTER" && probe.status === "DEAD_LETTER" && probe.attemptCount === DATA_ERROR_ATTEMPTS && calls === DATA_ERROR_ATTEMPTS && probe.lastErrorCode === "DATA_P2003",
    `${evt.status}, ${probe.attemptCount} attempts, ${probe.lastErrorCode}`);
  const others = await prisma.domainEventDelivery.findMany({ where: { eventId, consumerName: { not: "bounded-retry-probe" } }, select: { status: true } });
  report("…the event's other consumers still processed it", others.length > 0 && others.every((d) => d.status === "PROCESSED"));
  const dl = await listDeadLetters(platform, { limit: 500 });
  report("…and it is in the dead-letter list with the failing consumer", dl.some((d) => d.eventId === eventId && d.deliveries.some((x) => x.consumerName === "bounded-retry-probe" && x.lastErrorCode === "DATA_P2003")));

  // ── 2. A workflow timer that fails permanently ─────────────────────────────
  const def = await prisma.workflowDefinition.findFirstOrThrow({ where: { key: "collections-followup", organizationId: null }, select: { id: true, currentVersionId: true } });
  const inst = await prisma.workflowInstance.create({
    data: {
      workflowDefinitionId: def.id, workflowVersionId: def.currentVersionId!, triggerEventId: `bounded-trigger-${run}`, idempotencyKey: `bounded-${run}`,
      organizationId: fac.organizationId, facilityId: `gone-facility-${run}`, aggregateType: "INVOICE", aggregateId: marker,
      status: "COMPLETED", correlationId: marker, completedAt: new Date(),
    },
  });
  const timer = await prisma.workflowTimer.create({
    data: {
      workflowInstanceId: inst.id, kind: "SLA", availableAt: new Date(Date.now() - 1000), status: "PENDING", idempotencyKey: `bounded-sla-${run}`,
      payload: { escalation: { taskType: "PROBE_ESCALATION", title: "probe", priority: "URGENT" } },
    },
  });
  await tickWorkflows({});
  await tickWorkflows({});
  const t = await prisma.workflowTimer.findUniqueOrThrow({ where: { id: timer.id } });
  const i = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
  report("A timer whose escalation hits a missing parent is FAILED after one attempt (permanent), never retried",
    t.status === "FAILED" && t.attemptCount === 1 && i.failureCategory === "NOT_FOUND", `${t.status}, ${t.attemptCount} attempt(s), ${i.failureCategory}`);
  const wdl = await listWorkflowDeadLetters(platform, { limit: 500 });
  report("…and the instance is in the workflow dead-letter list with its failed timer", wdl.some((w) => w.id === inst.id && w.failedTimer?.kind === "SLA"));

  // ── 3. Stale RUNNING instances ─────────────────────────────────────────────
  const stale = (n: number) => prisma.workflowInstance.create({
    data: {
      workflowDefinitionId: def.id, workflowVersionId: def.currentVersionId!, triggerEventId: `bounded-stale-${n}-${run}`, idempotencyKey: `bounded-stale-${n}-${run}`,
      organizationId: fac.organizationId, facilityId, aggregateType: "INVOICE", aggregateId: marker, correlationId: marker,
      status: "RUNNING", claimToken: `dead-worker-${n}`, attemptCount: n, lastAttemptAt: new Date(Date.now() - LIMITS.STALE_CLAIM_MS - 60_000),
    },
  });
  const [young, old] = [await stale(1), await stale(LIMITS.MAX_INSTANCE_ATTEMPTS)];
  await tickWorkflows({});
  const [y, o] = [await prisma.workflowInstance.findUniqueOrThrow({ where: { id: young.id } }), await prisma.workflowInstance.findUniqueOrThrow({ where: { id: old.id } })];
  report("A stale RUNNING instance with attempts left is reaped back to RUNNABLE", y.status === "RUNNABLE" && y.claimToken === null, y.status);
  report(`…and one with ${LIMITS.MAX_INSTANCE_ATTEMPTS} attempts used is FAILED and listed`, o.status === "FAILED"
    && (await listWorkflowDeadLetters(platform, { limit: 500 })).some((w) => w.id === old.id), o.status);
  await prisma.workflowInstance.update({ where: { id: young.id }, data: { status: "CANCELLED" } }); // leave nothing runnable behind

  // ── 4. Tenancy-sweep fixtures stay out of the queues ───────────────────────
  const sweepFacility = "fac-tenancy-sweep-other";
  const live = await prisma.workflowInstance.count({ where: { facilityId: sweepFacility, status: { in: ["RUNNABLE", "RUNNING"] } } });
  const queued = await prisma.domainEventOutbox.count({ where: { facilityId: sweepFacility, status: { in: ["PENDING", "RETRY", "PROCESSING"] } } });
  report("The tenancy sweep leaves no RUNNABLE/RUNNING instance and no queued event", live === 0 && queued === 0, `${live} instances, ${queued} events`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
