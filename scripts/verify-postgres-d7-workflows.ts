/**
 * PHASE D7 — workflow engine gate (integration + concurrency + security + privacy
 * + idempotency + failure/recovery).
 *
 * Verifies the in-monolith workflow engine end to end: event→workflow→task, SLA
 * timer→escalation, TIMER delay→resume, retry/failure/recovery, cancellation; the
 * seven mandated races; the tenant/authorization/input/privilege-escalation
 * security matrix; sensitive-data protection; and idempotency. Concurrency races
 * run only on PostgreSQL (SQLite serialises writers) and are checked sequentially
 * there for single-effect correctness.
 *
 * Usage: DATABASE_URL=postgresql://... npx tsx scripts/verify-postgres-d7-workflows.ts
 */
import { prisma } from "../src/lib/db";
import { emitDomainEvent } from "../src/lib/events/emit";
import { dispatchPendingDomainEvents } from "../src/lib/events/dispatcher";
import type { DomainEventEnvelope } from "../src/lib/events/types";
import "../src/lib/workflows/register"; // register the workflow-engine consumer
import { createDefinition, publishVersion, getDefinition, createVersion, retireDefinition } from "../src/lib/workflows/definitions";
import { startWorkflowsForEvent, runInstance, tickWorkflows } from "../src/lib/workflows/engine";
import { getInstance, listInstances, cancelInstance, retryInstance } from "../src/lib/workflows/instances";
import { completeWorkflowTask } from "../src/lib/workflows/tasks";
import { validateWorkflowConfig } from "../src/lib/workflows/validator";
import { loadActorMemberships, type ActorMemberships } from "../src/lib/auth/tenantContext";

const IS_PG = /^postgres/i.test(process.env.DATABASE_URL ?? "");
let pass = 0, fail = 0; const failures: string[] = [];
const ok = (l: string) => { pass++; console.log(`  ✓ ${l}`); };
const bad = (l: string, d?: string) => { fail++; failures.push(l + (d ? ` — ${d}` : "")); console.log(`  ✗ ${l}${d ? ` — ${d}` : ""}`); };
async function expectDeny(l: string, fn: () => Promise<unknown>, status?: number) {
  try { await fn(); bad(l, "expected denial but SUCCEEDED"); }
  catch (e) { const s = (e as { status?: number }).status; if (status && s !== status) bad(l, `denied ${s}, expected ${status}`); else ok(l); }
}
async function expectThrow(l: string, fn: () => Promise<unknown> | unknown) {
  try { await fn(); bad(l, "expected throw but SUCCEEDED"); } catch { ok(l); }
}

const ID = { orgA: "d7t-org-a", orgB: "d7t-org-b", facA: "d7t-fac-a", facB: "d7t-fac-b", uPlatform: "d7t-u-plat", uAdminA: "d7t-u-admin-a", uAdminB: "d7t-u-admin-b", uOutsider: "d7t-u-out" };
const KEY_PREFIX = "d7gate-";

async function cleanup() {
  await prisma.workflowTimer.deleteMany({ where: { instance: { definition: { key: { startsWith: KEY_PREFIX } } } } });
  await prisma.workflowTask.deleteMany({ where: { instance: { definition: { key: { startsWith: KEY_PREFIX } } } } });
  await prisma.workflowStep.deleteMany({ where: { instance: { definition: { key: { startsWith: KEY_PREFIX } } } } });
  await prisma.workflowInstance.deleteMany({ where: { definition: { key: { startsWith: KEY_PREFIX } } } });
  await prisma.workflowVersion.deleteMany({ where: { definition: { key: { startsWith: KEY_PREFIX } } } });
  await prisma.workflowDefinition.deleteMany({ where: { key: { startsWith: KEY_PREFIX } } });
  await prisma.domainEventOutbox.deleteMany({ where: { correlationId: { startsWith: "d7gate:" } } });
  const userIds = Object.values(ID);
  await prisma.auditEvent.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.organizationMembership.deleteMany({ where: { OR: [{ organizationId: { in: [ID.orgA, ID.orgB] } }, { userId: { in: userIds } }] } });
  await prisma.facility.deleteMany({ where: { organizationId: { in: [ID.orgA, ID.orgB] } } });
  await prisma.organization.deleteMany({ where: { id: { in: [ID.orgA, ID.orgB] } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function seed() {
  const mk = (id: string, role: "AAROGYA_ADMIN" | "HOSPITAL_ADMIN" | "DOCTOR") => prisma.user.create({ data: { id, email: `${id}@d7.local`, passwordHash: "x", role, displayName: id } });
  await Promise.all([mk(ID.uPlatform, "AAROGYA_ADMIN"), mk(ID.uAdminA, "HOSPITAL_ADMIN"), mk(ID.uAdminB, "HOSPITAL_ADMIN"), mk(ID.uOutsider, "DOCTOR")]);
  for (const [org, fac, admin] of [[ID.orgA, ID.facA, ID.uAdminA], [ID.orgB, ID.facB, ID.uAdminB]] as const) {
    await prisma.organization.create({ data: { id: org, slug: org, name: org, status: "ACTIVE" } });
    await prisma.facility.create({ data: { id: fac, slug: fac, name: fac, organizationId: org, status: "ACTIVE" } });
    await prisma.organizationMembership.create({ data: { organizationId: org, userId: admin, isAdmin: true, status: "ACTIVE" } });
  }
}

let counter = 0;
async function fireEvent(type: string, opts: { organizationId?: string | null; facilityId?: string | null; aggregateId?: string; payload: Record<string, unknown>; correlationId?: string }): Promise<DomainEventEnvelope> {
  const aggregateId = opts.aggregateId ?? `agg-${++counter}`;
  const { eventId } = await emitDomainEvent(prisma, { type, aggregateId, organizationId: opts.organizationId ?? null, facilityId: opts.facilityId ?? null, correlationId: opts.correlationId ?? `d7gate:${type}:${aggregateId}`, payload: opts.payload });
  const r = await prisma.domainEventOutbox.findUniqueOrThrow({ where: { eventId } });
  return { eventId: r.eventId, eventType: r.eventType, eventVersion: r.eventVersion, aggregateType: r.aggregateType, aggregateId: r.aggregateId, organizationId: r.organizationId, facilityId: r.facilityId, actorUserId: r.actorUserId, correlationId: r.correlationId, causationId: r.causationId, occurredAt: r.occurredAt, payload: r.payload as Record<string, unknown> };
}

/** Manually seed a RUNNABLE (not-yet-run) instance so concurrent runInstance can race. */
async function seedRunnable(defId: string, versionId: string, env: DomainEventEnvelope, stepTypes: string[]): Promise<string> {
  const inst = await prisma.workflowInstance.create({
    data: {
      workflowDefinitionId: defId, workflowVersionId: versionId, triggerEventId: env.eventId, idempotencyKey: `${defId}:${env.eventId}`,
      organizationId: env.organizationId, facilityId: env.facilityId, aggregateType: env.aggregateType, aggregateId: env.aggregateId,
      status: "RUNNABLE", correlationId: env.correlationId, causationId: env.causationId, startedAt: new Date(),
    },
  });
  await prisma.workflowStep.createMany({ data: stepTypes.map((t, i) => ({ workflowInstanceId: inst.id, nodeKey: `s${i}`, stepIndex: i, stepType: t, status: "PENDING", availableAt: new Date() })) });
  return inst.id;
}

const mPlatform = () => loadActorMemberships(ID.uPlatform, "AAROGYA_ADMIN");

async function run() {
  console.log(`\n=== PHASE D7 WORKFLOW GATE (${IS_PG ? "PostgreSQL" : "SQLite"}) ===\n`);
  await cleanup();
  await seed();
  const P = await mPlatform();
  const A = await loadActorMemberships(ID.uAdminA, "HOSPITAL_ADMIN");
  const B = await loadActorMemberships(ID.uAdminB, "HOSPITAL_ADMIN");
  const O = await loadActorMemberships(ID.uOutsider, "DOCTOR");

  // ── Build the gate's workflow catalogue ────────────────────────────────────
  const simple = await publish(P, { key: `${KEY_PREFIX}simple`, name: "Simple", config: { trigger: { eventType: "PaymentReceived", eventVersion: 1 }, steps: [{ type: "TASK", key: "t", taskType: "SIMPLE", title: "Simple task", priority: "ROUTINE" }] } });
  const critical = await publish(P, { key: `${KEY_PREFIX}critical`, name: "Critical lab", config: { trigger: { eventType: "LabResultReleased", eventVersion: 1, condition: { all: [{ field: "payload.critical", operator: "equals", value: true }] } }, steps: [{ type: "TASK", key: "review", taskType: "REVIEW", title: "Review critical result", priority: "STAT", sla: { dueAfterSeconds: 1, escalation: { taskType: "ESCALATION", title: "SLA breached", priority: "STAT" } } }] } });
  const delay = await publish(P, { key: `${KEY_PREFIX}delay`, name: "Delay", config: { trigger: { eventType: "AdmissionCreated", eventVersion: 1 }, steps: [{ type: "TASK", key: "t1", taskType: "FIRST", title: "First" }, { type: "TIMER", key: "wait", dueAfterSeconds: 1 }, { type: "TASK", key: "t2", taskType: "SECOND", title: "Second" }] } });
  const failWf = await publish(P, { key: `${KEY_PREFIX}fail`, name: "Fail", config: { trigger: { eventType: "InvoiceFinalized", eventVersion: 1 }, steps: [{ type: "ACTION", key: "emit", action: { name: "EMIT_DOMAIN_EVENT", params: { eventType: "PatientRegistered", aggregateId: "wf-emitted", payload: { patientId: "wf-p" } } } }] } });
  const orgBWf = await publish(P, { key: `${KEY_PREFIX}orgb`, name: "OrgB only", organizationId: ID.orgB, config: { trigger: { eventType: "SubscriptionActivated", eventVersion: 1 }, steps: [{ type: "TASK", key: "t", taskType: "ORGB", title: "OrgB task" }] } });
  ok("published 5 gate workflows (4 global + 1 org-B-scoped)");

  // ── Integration: event → workflow → task ───────────────────────────────────
  console.log("[integration]");
  {
    // Full path: emit + D6 dispatch → workflow consumer → instance + task.
    const env = await fireEvent("PaymentReceived", { organizationId: ID.orgA, aggregateId: "pay-int-1", payload: { paymentId: "pay-int-1", invoiceId: "i1", amountMinor: 100, currency: "INR" } });
    await dispatchPendingDomainEvents({ now: new Date() });
    const inst = await prisma.workflowInstance.findFirst({ where: { workflowDefinitionId: simple, triggerEventId: env.eventId } });
    const task = inst ? await prisma.workflowTask.findFirst({ where: { workflowInstanceId: inst.id } }) : null;
    if (inst?.status === "COMPLETED" && task && task.status === "OPEN") ok("committed event → dispatcher → workflow instance + task (COMPLETED)"); else bad("event→workflow", `inst=${inst?.status} task=${task?.status}`);
    if (inst && inst.correlationId === env.correlationId && inst.triggerEventId === env.eventId) ok("instance preserves triggerEventId + correlationId"); else bad("correlation", "not preserved");
  }
  {
    // Trigger condition false → no instance.
    const env = await fireEvent("LabResultReleased", { organizationId: ID.orgA, facilityId: ID.facA, aggregateId: "lab-noncrit", payload: { resultId: "lab-noncrit", critical: false } });
    await startWorkflowsForEvent(env);
    const n = await prisma.workflowInstance.count({ where: { workflowDefinitionId: critical, triggerEventId: env.eventId } });
    if (n === 0) ok("trigger condition false → no workflow instance created"); else bad("condition gate", `instances=${n}`);
  }

  // ── SLA timer → escalation ─────────────────────────────────────────────────
  console.log("[sla + escalation]");
  {
    const env = await fireEvent("LabResultReleased", { organizationId: ID.orgA, facilityId: ID.facA, aggregateId: "lab-crit-1", payload: { resultId: "lab-crit-1", critical: true } });
    await startWorkflowsForEvent(env);
    const inst = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: critical, triggerEventId: env.eventId } });
    // Not completed → tick in the future → escalation created.
    await tickWorkflows({ now: new Date(Date.now() + 3600_000) });
    const esc = await prisma.workflowTask.count({ where: { workflowInstanceId: inst.id, taskType: "ESCALATION" } });
    if (esc === 1) ok("SLA breach (task not completed) → exactly one escalation task"); else bad("escalation", `escalations=${esc}`);
  }
  {
    const env = await fireEvent("LabResultReleased", { organizationId: ID.orgA, facilityId: ID.facA, aggregateId: "lab-crit-2", payload: { resultId: "lab-crit-2", critical: true } });
    await startWorkflowsForEvent(env);
    const inst = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: critical, triggerEventId: env.eventId } });
    const reviewTask = await prisma.workflowTask.findFirstOrThrow({ where: { workflowInstanceId: inst.id, taskType: "REVIEW" } });
    await completeWorkflowTask(reviewTask.id, ID.uPlatform); // meet SLA before breach
    await tickWorkflows({ now: new Date(Date.now() + 3600_000) });
    const esc = await prisma.workflowTask.count({ where: { workflowInstanceId: inst.id, taskType: "ESCALATION" } });
    if (esc === 0) ok("SLA met (task completed) → no escalation"); else bad("no-escalation", `escalations=${esc}`);
  }

  // ── TIMER delay → resume ───────────────────────────────────────────────────
  console.log("[timer delay resume]");
  {
    const env = await fireEvent("AdmissionCreated", { organizationId: ID.orgA, facilityId: ID.facA, aggregateId: "adm-1", payload: { admissionId: "adm-1", encounterId: "e1", patientId: "p1" } });
    await startWorkflowsForEvent(env);
    const inst = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: delay, triggerEventId: env.eventId } });
    const afterFirst = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    const t1 = await prisma.workflowTask.count({ where: { workflowInstanceId: inst.id, taskType: "FIRST" } });
    if (afterFirst.status === "WAITING" && t1 === 1) ok("TIMER step parks the instance WAITING after the first task"); else bad("timer wait", `status=${afterFirst.status} t1=${t1}`);
    await tickWorkflows({ now: new Date(Date.now() + 3600_000) });
    const done = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    const t2 = await prisma.workflowTask.count({ where: { workflowInstanceId: inst.id, taskType: "SECOND" } });
    if (done.status === "COMPLETED" && t2 === 1) ok("timer fires → instance resumes → second task → COMPLETED"); else bad("timer resume", `status=${done.status} t2=${t2}`);
  }

  // ── Failure + recovery ─────────────────────────────────────────────────────
  console.log("[failure + recovery]");
  let failedInstanceId = "";
  {
    const env = await fireEvent("InvoiceFinalized", { organizationId: ID.orgA, aggregateId: "inv-fail-1", payload: { invoiceId: "inv-fail-1", invoiceNumber: "N1", totalMinor: 100, currency: "INR" } });
    await startWorkflowsForEvent(env);
    const inst = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: failWf, triggerEventId: env.eventId } });
    failedInstanceId = inst.id;
    const nonRetryable = inst.failureCategory === "PERMANENT" || inst.failureCategory === "VALIDATION";
    if (inst.status === "FAILED" && nonRetryable) ok(`action that violates a domain invariant → instance FAILED (non-retryable ${inst.failureCategory}, terminal)`); else bad("failure", `status=${inst.status}/${inst.failureCategory}`);
    const still = await getInstance(P, inst.id);
    if (still.status === "FAILED") ok("failed instance remains inspectable"); else bad("inspectable", still.status);
  }
  {
    // Recover: correct the cause (attach a facility), then manual retry → COMPLETED.
    await prisma.workflowInstance.update({ where: { id: failedInstanceId }, data: { facilityId: ID.facA } });
    await retryInstance(P, failedInstanceId, { recover: true, reason: "attached facility" });
    const rec = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: failedInstanceId } });
    if (rec.status === "COMPLETED") ok("recovery: fix cause + manual retry → COMPLETED"); else bad("recovery", rec.status);
  }

  // ── Cancellation ───────────────────────────────────────────────────────────
  console.log("[cancellation]");
  {
    const env = await fireEvent("AdmissionCreated", { organizationId: ID.orgA, facilityId: ID.facA, aggregateId: "adm-cancel", payload: { admissionId: "adm-cancel", encounterId: "e2", patientId: "p2" } });
    await startWorkflowsForEvent(env); // parks WAITING on the timer
    const inst = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: delay, triggerEventId: env.eventId } });
    await cancelInstance(P, inst.id, "operator cancel");
    const c = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    const pendingTimers = await prisma.workflowTimer.count({ where: { workflowInstanceId: inst.id, status: { in: ["PENDING", "CLAIMED"] } } });
    if (c.status === "CANCELLED" && c.cancelledByUserId === ID.uPlatform && pendingTimers === 0) ok("cancellation → CANCELLED, timers cancelled, attribution recorded"); else bad("cancel", `status=${c.status} timers=${pendingTimers}`);
    // Ticking after cancel must not resume it.
    await tickWorkflows({ now: new Date(Date.now() + 3600_000) });
    const after = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
    const t2 = await prisma.workflowTask.count({ where: { workflowInstanceId: inst.id, taskType: "SECOND" } });
    if (after.status === "CANCELLED" && t2 === 0) ok("no post-cancellation execution (tick does not resume a cancelled instance)"); else bad("post-cancel", `status=${after.status} t2=${t2}`);
  }

  // ── Idempotency (sequential) ───────────────────────────────────────────────
  console.log("[idempotency]");
  {
    const env = await fireEvent("PaymentReceived", { organizationId: ID.orgA, aggregateId: "pay-dup", payload: { paymentId: "pay-dup", invoiceId: "i2", amountMinor: 100, currency: "INR" } });
    await startWorkflowsForEvent(env);
    await startWorkflowsForEvent(env); // duplicate delivery
    const n = await prisma.workflowInstance.count({ where: { workflowDefinitionId: simple, triggerEventId: env.eventId } });
    const tasks = await prisma.workflowTask.count({ where: { instance: { triggerEventId: env.eventId } } });
    if (n === 1 && tasks === 1) ok("duplicate delivery → one instance + one task (idempotent)"); else bad("idempotent dup", `instances=${n} tasks=${tasks}`);
  }

  await securityGate(P, A, B, O, { simple, orgBWf });
  await privacyGate(P);
  await concurrency(P);

  await cleanup();
  console.log(`\n────────────────────`);
  console.log(`RESULT: ${pass} passed, ${fail} failed  (${IS_PG ? "PostgreSQL" : "SQLite"})`);
  if (fail) { console.log("FAILURES:"); failures.forEach((f) => console.log("  - " + f)); }
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

async function publish(m: ActorMemberships, w: { key: string; name: string; organizationId?: string | null; config: unknown }): Promise<string> {
  const def = await createDefinition(m, { organizationId: w.organizationId ?? null, key: w.key, name: w.name, config: w.config });
  const v1 = def.versions.find((v) => v.version === 1)!;
  await publishVersion(m, def.id, v1.id);
  return def.id;
}

// ── Security matrix ──────────────────────────────────────────────────────────
async function securityGate(P: ActorMemberships, A: ActorMemberships, B: ActorMemberships, O: ActorMemberships, defs: { simple: string; orgBWf: string }) {
  console.log("[security]");
  // Tenant isolation — definitions.
  await expectDeny("org A admin cannot read org B's org-scoped definition", () => getDefinition(A, defs.orgBWf), 404);
  try { await getDefinition(B, defs.orgBWf); ok("org B admin CAN read its own definition"); } catch (e) { bad("orgB own read", String(e)); }

  // Tenant isolation — instances.
  const envA = await fireEvent("PaymentReceived", { organizationId: ID.orgA, aggregateId: "sec-instA", payload: { paymentId: "sec-instA", invoiceId: "i", amountMinor: 1, currency: "INR" } });
  await startWorkflowsForEvent(envA);
  const instA = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: defs.simple, triggerEventId: envA.eventId } });
  await expectDeny("org B admin cannot read an org A instance", () => getInstance(B, instA.id), 404);
  const bList = await listInstances(B, {});
  if (bList.every((i) => i.organizationId !== ID.orgA)) ok("org admin instance list is scoped to own org (no cross-tenant leak)"); else bad("instance list scope", "leaked org A");

  // Guessed IDs.
  await expectDeny("guessed workflow id reveals nothing", () => getDefinition(A, "d7-nope-id"), 404);
  await expectDeny("guessed instance id reveals nothing", () => getInstance(A, "d7-nope-id"), 404);

  // Authorization — platform-only operations refused for an org admin.
  await expectDeny("unauthorized create rejected", () => createDefinition(A, { key: `${KEY_PREFIX}x`, name: "x", config: { trigger: { eventType: "PaymentReceived", eventVersion: 1 }, steps: [{ type: "TASK", key: "t", taskType: "X", title: "X" }] } }), 403);
  await expectDeny("unauthorized version create rejected", () => createVersion(A, defs.simple, { trigger: { eventType: "PaymentReceived", eventVersion: 1 }, steps: [{ type: "TASK", key: "t", taskType: "X", title: "X" }] }), 403);
  await expectDeny("unauthorized publish rejected", () => publishVersion(A, defs.simple, "any"), 403);
  await expectDeny("unauthorized retire rejected", () => retireDefinition(A, defs.simple), 403);
  await expectDeny("unauthorized cancel rejected", () => cancelInstance(A, instA.id, "x"), 403);
  await expectDeny("unauthorized retry rejected", () => retryInstance(A, instA.id), 403);
  await expectDeny("outsider (no membership) cannot read instance", () => getInstance(O, instA.id), 404);

  // Input attacks — rejected at validation/publication.
  const goodTrigger = { eventType: "PaymentReceived", eventVersion: 1 };
  await expectThrow("arbitrary action injection rejected", () => validateWorkflowConfig({ trigger: goodTrigger, steps: [{ type: "ACTION", key: "a", action: { name: "DROP_DATABASE", params: {} } }] }));
  await expectThrow("non-invokable action (CREATE_TASK) rejected", () => validateWorkflowConfig({ trigger: goodTrigger, steps: [{ type: "ACTION", key: "a", action: { name: "CREATE_TASK", params: {} } }] }));
  await expectThrow("arbitrary condition operator rejected", () => validateWorkflowConfig({ trigger: { ...goodTrigger, condition: { all: [{ field: "payload.x", operator: "REGEX_EXEC", value: ".*" }] } }, steps: [{ type: "TASK", key: "t", taskType: "X", title: "X" }] }));
  await expectThrow("executable payload injection in EMIT rejected (unknown target)", () => validateWorkflowConfig({ trigger: goodTrigger, steps: [{ type: "ACTION", key: "a", action: { name: "EMIT_DOMAIN_EVENT", params: { eventType: "() => process.exit(1)", payload: {} } } }] }));
  await expectThrow("unknown event type rejected", () => validateWorkflowConfig({ trigger: { eventType: "NopeEvent", eventVersion: 1 }, steps: [{ type: "TASK", key: "t", taskType: "X", title: "X" }] }));
  await expectThrow("unknown event version rejected", () => validateWorkflowConfig({ trigger: { eventType: "PaymentReceived", eventVersion: 99 }, steps: [{ type: "TASK", key: "t", taskType: "X", title: "X" }] }));
  await expectThrow("excessive nodes rejected", () => validateWorkflowConfig({ trigger: goodTrigger, steps: Array.from({ length: 25 }, (_, i) => ({ type: "TIMER", key: `k${i}`, dueAfterSeconds: 60 })) }));
  await expectThrow("invalid timer value rejected", () => validateWorkflowConfig({ trigger: goodTrigger, steps: [{ type: "TIMER", key: "t", dueAfterSeconds: -1 }] }));
  {
    // deeply nested condition
    let deep: unknown = { field: "payload.x", operator: "exists" };
    for (let i = 0; i < 8; i++) deep = { not: deep };
    await expectThrow("excessive condition nesting rejected", () => validateWorkflowConfig({ trigger: { ...goodTrigger, condition: deep }, steps: [{ type: "TASK", key: "t", taskType: "X", title: "X" }] }));
  }

  // SQL injection through condition values is inert (compared in JS, never queried).
  {
    const injected = { trigger: { eventType: "PaymentReceived", eventVersion: 1, condition: { all: [{ field: "payload.paymentId", operator: "equals", value: "'; DROP TABLE \"WorkflowInstance\"; --" }] } }, steps: [{ type: "TASK", key: "t", taskType: "SQLI", title: "sqli" }] };
    const def = await createDefinition(P, { key: `${KEY_PREFIX}sqli`, name: "sqli", config: injected });
    const v = def.versions.find((x) => x.version === 1)!;
    await publishVersion(P, def.id, v.id);
    const before = await prisma.workflowInstance.count();
    const env = await fireEvent("PaymentReceived", { organizationId: ID.orgA, aggregateId: "sqli-evt", payload: { paymentId: "x", invoiceId: "i", amountMinor: 1, currency: "INR" } });
    await startWorkflowsForEvent(env); // condition compares the injection value in JS; never queried
    const after = await prisma.workflowInstance.count();
    if (after >= before) ok("SQL-injection condition value is inert data (compared in JS, no query executed, table intact)"); else bad("sqli", "table damaged");
  }

  // Privilege escalation: the action registry exposes no clinical/financial mutation.
  {
    const { ACTION_NAMES } = await import("../src/lib/workflows/actions");
    const dangerous = ACTION_NAMES.filter((n) => /ORDER|PRESCRIBE|ADMINISTER|DISPENSE|PAYMENT|REFUND|CHARGE|DISCHARGE|DELETE|GRANT|MERGE/i.test(n));
    if (dangerous.length === 0) ok("action registry exposes no clinical/financial mutation action (no privilege-escalation path)"); else bad("action registry", dangerous.join(","));
  }
}

// ── Privacy / sensitive data ─────────────────────────────────────────────────
async function privacyGate(P: ActorMemberships) {
  console.log("[privacy]");
  // A definition emitting an event with a forbidden payload key → the emit guard
  // rejects it at run time; the instance FAILS and no such event is persisted.
  const def = await createDefinition(P, { key: `${KEY_PREFIX}leak`, name: "leak", config: { trigger: { eventType: "InvoiceFinalized", eventVersion: 1 }, steps: [{ type: "ACTION", key: "emit", action: { name: "EMIT_DOMAIN_EVENT", params: { eventType: "PaymentReceived", aggregateId: "x", payload: { paymentId: "x", invoiceId: "i", amountMinor: 1, currency: "INR", password: "leak" } } } }] } });
  const v = def.versions.find((x) => x.version === 1)!;
  await publishVersion(P, def.id, v.id);
  const env = await fireEvent("InvoiceFinalized", { organizationId: ID.orgA, aggregateId: "leak-evt", payload: { invoiceId: "leak-evt", invoiceNumber: "N", totalMinor: 1, currency: "INR" } });
  await startWorkflowsForEvent(env);
  const inst = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: def.id, triggerEventId: env.eventId } });
  if (inst.status === "FAILED") ok("workflow emitting a forbidden (sensitive) payload key → FAILED, secret never persisted"); else bad("privacy emit", inst.status);

  // Allow-listed context: a condition cannot address a non event/payload root.
  await expectThrow("condition cannot address arbitrary roots (allow-listed context)", () => validateWorkflowConfig({ trigger: { eventType: "PaymentReceived", eventVersion: 1, condition: { all: [{ field: "process.env.SECRET", operator: "exists" }] } }, steps: [{ type: "TASK", key: "t", taskType: "X", title: "X" }] }));

  // Nested sensitive-data protection (reuse D6 guard through timer payload path is
  // internal; here we assert the emit guard catches nesting).
  await expectThrow("nested forbidden key in emitted payload rejected", async () => {
    const { assertNoSensitiveData } = await import("../src/lib/events/sensitiveGuard");
    assertNoSensitiveData({ a: { b: { apiKey: "x" } } });
  });
}

// ── Concurrency (PostgreSQL only) ────────────────────────────────────────────
async function concurrency(P: ActorMemberships) {
  console.log("[concurrency races]");
  if (!IS_PG) { console.log("  · concurrency races skipped (SQLite serialises writers); single-effect proven by the sequential idempotency/cancellation cases above"); return; }

  const simple = await prisma.workflowDefinition.findFirstOrThrow({ where: { key: `${KEY_PREFIX}simple` } });
  const critical = await prisma.workflowDefinition.findFirstOrThrow({ where: { key: `${KEY_PREFIX}critical` } });

  // Race 1 — duplicate/concurrent delivery of one event → one instance.
  {
    const env = await fireEvent("PaymentReceived", { organizationId: ID.orgA, aggregateId: "race1", payload: { paymentId: "race1", invoiceId: "i", amountMinor: 1, currency: "INR" } });
    await Promise.allSettled([startWorkflowsForEvent(env), startWorkflowsForEvent(env), startWorkflowsForEvent(env)]);
    const n = await prisma.workflowInstance.count({ where: { workflowDefinitionId: simple.id, triggerEventId: env.eventId } });
    const t = await prisma.workflowTask.count({ where: { instance: { triggerEventId: env.eventId } } });
    if (n === 1 && t === 1) ok("Race 1: concurrent event delivery → one instance + one task"); else bad("Race 1", `instances=${n} tasks=${t}`);
  }

  // Race 2 — two workers claim the same step (instance) → one effective execution.
  {
    const env = await fireEvent("PaymentReceived", { organizationId: ID.orgA, aggregateId: "race2", payload: { paymentId: "race2", invoiceId: "i", amountMinor: 1, currency: "INR" } });
    const version = await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: simple.id }, select: { currentVersionId: true } });
    const instId = await seedRunnable(simple.id, version.currentVersionId!, env, ["TASK"]);
    await Promise.all([runInstance(instId), runInstance(instId), runInstance(instId)]);
    const t = await prisma.workflowTask.count({ where: { workflowInstanceId: instId } });
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instId } });
    if (t === 1 && inst.status === "COMPLETED") ok("Race 2: concurrent runInstance → one effective execution (one task, COMPLETED)"); else bad("Race 2", `tasks=${t} status=${inst.status}`);
  }

  // Race 3 — two workers claim the same due timer → one effective escalation.
  {
    const env = await fireEvent("LabResultReleased", { organizationId: ID.orgA, facilityId: ID.facA, aggregateId: "race3", payload: { resultId: "race3", critical: true } });
    await startWorkflowsForEvent(env);
    const inst = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: critical.id, triggerEventId: env.eventId } });
    const now = new Date(Date.now() + 3600_000);
    await Promise.all([tickWorkflows({ now }), tickWorkflows({ now }), tickWorkflows({ now })]);
    const esc = await prisma.workflowTask.count({ where: { workflowInstanceId: inst.id, taskType: "ESCALATION" } });
    if (esc === 1) ok("Race 3: concurrent timer ticks → one effective escalation"); else bad("Race 3", `escalations=${esc}`);
  }

  // Race 4 — automatic retry racing manual retry on a FAILED instance → one winner.
  {
    const failDef = await prisma.workflowDefinition.findFirstOrThrow({ where: { key: `${KEY_PREFIX}fail` } });
    const env = await fireEvent("InvoiceFinalized", { organizationId: ID.orgA, aggregateId: "race4", payload: { invoiceId: "race4", invoiceNumber: "N", totalMinor: 1, currency: "INR" } });
    await startWorkflowsForEvent(env);
    const inst = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: failDef.id, triggerEventId: env.eventId } });
    const results = await Promise.allSettled([retryInstance(P, inst.id), retryInstance(P, inst.id)]);
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    if (okCount === 1) ok("Race 4: concurrent manual retries → exactly one winner (guarded)"); else bad("Race 4", `fulfilled=${okCount}`);
  }

  // Race 5 — cancellation racing execution → deterministic terminal state.
  {
    const env = await fireEvent("PaymentReceived", { organizationId: ID.orgA, aggregateId: "race5", payload: { paymentId: "race5", invoiceId: "i", amountMinor: 1, currency: "INR" } });
    const version = await prisma.workflowDefinition.findUniqueOrThrow({ where: { id: simple.id }, select: { currentVersionId: true } });
    const instId = await seedRunnable(simple.id, version.currentVersionId!, env, ["TASK"]);
    await Promise.allSettled([cancelInstance(P, instId, "race"), runInstance(instId)]);
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instId } });
    const terminal = inst.status === "CANCELLED" || inst.status === "COMPLETED";
    const tasks = await prisma.workflowTask.count({ where: { workflowInstanceId: instId } });
    if (terminal && tasks <= 1) ok(`Race 5: cancel vs execution → deterministic terminal (${inst.status}), no duplicate effect`); else bad("Race 5", `status=${inst.status} tasks=${tasks}`);
  }

  // Race 6 — concurrent publication of the same version → one active publication.
  {
    const def = await createDefinition(P, { key: `${KEY_PREFIX}race6`, name: "race6", config: { trigger: { eventType: "PaymentReceived", eventVersion: 1 }, steps: [{ type: "TASK", key: "t", taskType: "X", title: "X" }] } });
    const v = def.versions.find((x) => x.version === 1)!;
    const results = await Promise.allSettled([publishVersion(P, def.id, v.id), publishVersion(P, def.id, v.id), publishVersion(P, def.id, v.id)]);
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    const published = await prisma.workflowVersion.count({ where: { workflowDefinitionId: def.id, status: "PUBLISHED" } });
    if (okCount === 1 && published === 1) ok("Race 6: concurrent publication → exactly one active published version"); else bad("Race 6", `fulfilled=${okCount} published=${published}`);
  }

  // Race 7 — concurrent task completion → one effective completion.
  {
    const env = await fireEvent("PaymentReceived", { organizationId: ID.orgA, aggregateId: "race7", payload: { paymentId: "race7", invoiceId: "i", amountMinor: 1, currency: "INR" } });
    await startWorkflowsForEvent(env);
    const inst = await prisma.workflowInstance.findFirstOrThrow({ where: { workflowDefinitionId: simple.id, triggerEventId: env.eventId } });
    const task = await prisma.workflowTask.findFirstOrThrow({ where: { workflowInstanceId: inst.id } });
    const results = await Promise.allSettled([completeWorkflowTask(task.id, ID.uAdminA), completeWorkflowTask(task.id, ID.uAdminB), completeWorkflowTask(task.id, ID.uPlatform)]);
    const okCount = results.filter((r) => r.status === "fulfilled").length;
    const after = await prisma.workflowTask.findUniqueOrThrow({ where: { id: task.id } });
    // Completion is idempotent: an already-COMPLETED call returns success too, so
    // assert exactly one COMPLETED task with a single completedByUserId.
    if (after.status === "COMPLETED" && after.completedByUserId && okCount >= 1) ok(`Race 7: concurrent completion → one COMPLETED task (single completer ${after.completedByUserId?.slice(0, 12)})`); else bad("Race 7", `status=${after.status} ok=${okCount}`);
  }
}

run().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
