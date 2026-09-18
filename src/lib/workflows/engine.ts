import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db";
import { emitDomainEvent } from "@/lib/events/emit";
import type { DomainEventEnvelope } from "@/lib/events/types";
import { evaluateCondition } from "./conditions";
import type { WorkflowConfig, StepConfig } from "./definition";
import { createWorkflowTask } from "./tasks";
import { createTimerTx } from "./timers";
import {
  LIMITS, classifyWorkflowError, isRetryable, safeMessage,
  type WorkflowContext, type FailureCategory,
} from "./types";

/**
 * Phase D7 — the workflow execution engine.
 *
 * Reacts to a committed D6 event: matches published workflows, evaluates the safe
 * trigger condition, idempotently creates a WorkflowInstance + its bounded linear
 * pipeline of steps, and runs it. Execution is:
 *   - idempotent: one instance per (definition, event) via a unique key; step
 *     effects (tasks/timers) carry their own idempotency keys;
 *   - concurrency-safe: an instance is claimed with a guarded conditional UPDATE +
 *     token, so only one worker executes it at a time (subsuming per-step races);
 *   - at-least-once: never claims exactly-once; every effect is idempotent;
 *   - bounded: linear pipeline (acyclic by construction), depth-capped to prevent
 *     event→workflow→event loops.
 * It orchestrates only — canonical clinical/financial mutations stay behind their
 * own domain services and authorization.
 */

const STEP_BACKOFF_BASE_MS = 30_000;
const STEP_BACKOFF_CAP_MS = 3_600_000;
function stepBackoff(now: Date, attempt: number): Date {
  return new Date(now.getTime() + Math.min(STEP_BACKOFF_CAP_MS, STEP_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1)));
}

type StepOutcome = "CONTINUE" | "WAIT" | "STOP_COMPLETE";

// ── Event → workflow ─────────────────────────────────────────────────────────

/** Called by the D6 workflow consumer for each delivered event. */
export async function startWorkflowsForEvent(envelope: DomainEventEnvelope): Promise<{ started: string[] }> {
  const defs = await prisma.workflowDefinition.findMany({
    where: { status: "ACTIVE", currentVersionId: { not: null }, triggerEventType: envelope.eventType, triggerEventVersion: envelope.eventVersion },
  });
  const started: string[] = [];
  const ctx = envelopeContext(envelope);

  for (const def of defs) {
    if (!def.currentVersionId) continue;
    const version = await prisma.workflowVersion.findUnique({ where: { id: def.currentVersionId } });
    if (!version || version.status !== "PUBLISHED") continue;
    const cfg = version.config as unknown as WorkflowConfig;
    if (cfg.trigger.condition && !evaluateCondition(ctx, cfg.trigger.condition)) continue;

    // Loop prevention (§31): cap the depth of one correlation chain.
    const chain = await prisma.workflowInstance.aggregate({ where: { correlationId: envelope.correlationId }, _max: { depth: true } });
    const depth = (chain._max.depth ?? -1) + 1;
    if (depth > LIMITS.MAX_INSTANCE_DEPTH) continue; // fail safe: refuse to extend the chain

    const idempotencyKey = `${def.id}:${envelope.eventId}`;
    let instanceId: string | null = null;
    try {
      instanceId = await prisma.$transaction(async (tx) => {
        const inst = await tx.workflowInstance.create({
          data: {
            workflowDefinitionId: def.id, workflowVersionId: version.id, triggerEventId: envelope.eventId, idempotencyKey,
            organizationId: envelope.organizationId, facilityId: envelope.facilityId,
            aggregateType: envelope.aggregateType, aggregateId: envelope.aggregateId,
            status: "RUNNABLE", correlationId: envelope.correlationId, causationId: envelope.causationId, depth, startedAt: new Date(),
          },
        });
        await tx.workflowStep.createMany({
          data: cfg.steps.map((s, i) => ({ workflowInstanceId: inst.id, nodeKey: s.key, stepIndex: i, stepType: s.type, status: "PENDING", availableAt: new Date() })),
        });
        return inst.id;
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") continue; // duplicate event delivery → one instance
      throw err;
    }
    if (instanceId) {
      started.push(instanceId);
      await runInstance(instanceId);
    }
  }
  return { started };
}

// ── Instance runner ──────────────────────────────────────────────────────────

/** Claim and advance one instance through its pipeline until it waits or terminates. */
export async function runInstance(instanceId: string, opts?: { now?: Date }): Promise<void> {
  const now = opts?.now ?? new Date();
  const token = randomUUID();
  const claim = await prisma.workflowInstance.updateMany({
    where: { id: instanceId, status: "RUNNABLE" },
    data: { status: "RUNNING", claimToken: token, lastAttemptAt: now, attemptCount: { increment: 1 } },
  });
  if (claim.count !== 1) return; // not runnable, or another worker owns it

  const inst = await prisma.workflowInstance.findUnique({ where: { id: instanceId }, include: { steps: { orderBy: { stepIndex: "asc" } } } });
  if (!inst) return;
  const version = await prisma.workflowVersion.findUniqueOrThrow({ where: { id: inst.workflowVersionId } });
  const cfg = version.config as unknown as WorkflowConfig;
  const evt = await prisma.domainEventOutbox.findUnique({ where: { eventId: inst.triggerEventId }, select: { payload: true, actorUserId: true } });
  const ctx = instanceContext(inst, (evt?.payload as Record<string, unknown> | undefined) ?? {}, evt?.actorUserId ?? null, cfg);

  for (const step of inst.steps) {
    if (step.status === "COMPLETED" || step.status === "SKIPPED") continue;

    // Re-verify ownership before each step so a concurrent cancel wins deterministically.
    const own = await prisma.workflowInstance.findUnique({ where: { id: instanceId }, select: { status: true, claimToken: true } });
    if (!own || own.status !== "RUNNING" || own.claimToken !== token) return;

    if (step.availableAt && step.availableAt > now) {
      // Retry backoff not yet due — release and let the tick pick it up later.
      await prisma.workflowInstance.updateMany({ where: { id: instanceId, claimToken: token }, data: { status: "RUNNABLE", claimToken: null } });
      return;
    }

    const stepCfg = cfg.steps[step.stepIndex];
    try {
      const outcome = await executeStep(inst, step, stepCfg, ctx, token, now);
      if (outcome === "WAIT") return; // TIMER step: instance parked WAITING
      if (outcome === "STOP_COMPLETE") {
        await prisma.workflowStep.updateMany({ where: { workflowInstanceId: instanceId, status: "PENDING", stepIndex: { gt: step.stepIndex } }, data: { status: "SKIPPED" } });
        await prisma.workflowInstance.updateMany({ where: { id: instanceId, claimToken: token }, data: { status: "COMPLETED", claimToken: null, completedAt: now } });
        return;
      }
    } catch (err) {
      await handleStepFailure(instanceId, step.id, step.attemptCount, step.maxAttempts, err, token, now);
      return;
    }
  }

  await prisma.workflowInstance.updateMany({ where: { id: instanceId, claimToken: token }, data: { status: "COMPLETED", claimToken: null, completedAt: now } });
}

async function executeStep(
  inst: { id: string; organizationId: string | null; facilityId: string | null; triggerEventId: string; correlationId: string },
  step: { id: string; stepIndex: number },
  stepCfg: StepConfig,
  ctx: WorkflowContext,
  token: string,
  now: Date,
): Promise<StepOutcome> {
  const markCompleted = (resultRef?: string | null) =>
    prisma.workflowStep.updateMany({ where: { id: step.id, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "COMPLETED", completedAt: now, startedAt: now, resultRef: resultRef ?? null } });

  if (stepCfg.type === "CONDITION") {
    const pass = evaluateCondition(ctx, stepCfg.condition);
    await markCompleted(null);
    return pass ? "CONTINUE" : "STOP_COMPLETE";
  }

  if (stepCfg.type === "TASK") {
    const patientId = typeof ctx.payload.patientId === "string" ? ctx.payload.patientId : null;
    const encounterId = typeof ctx.payload.encounterId === "string" ? ctx.payload.encounterId : null;
    await prisma.$transaction(async (tx) => {
      const task = await createWorkflowTask(tx, {
        workflowInstanceId: inst.id, workflowStepId: step.id, organizationId: inst.organizationId, facilityId: inst.facilityId,
        patientId, encounterId, taskType: stepCfg.taskType, title: stepCfg.title, description: stepCfg.description ?? null,
        priority: stepCfg.priority, assignedRole: stepCfg.assignedRole ?? null,
        dueAt: stepCfg.dueAfterSeconds ? new Date(now.getTime() + stepCfg.dueAfterSeconds * 1000) : (stepCfg.sla ? new Date(now.getTime() + stepCfg.sla.dueAfterSeconds * 1000) : null),
        idempotencyKey: `${step.id}:task`,
      });
      if (stepCfg.sla) {
        await createTimerTx(tx, {
          workflowInstanceId: inst.id, workflowStepId: step.id, kind: "SLA",
          availableAt: new Date(now.getTime() + stepCfg.sla.dueAfterSeconds * 1000),
          payload: { taskId: task.id, escalation: stepCfg.sla.escalation } as unknown as import("@prisma/client").Prisma.InputJsonValue,
          idempotencyKey: `${step.id}:sla`,
        });
      }
      await tx.workflowStep.updateMany({ where: { id: step.id, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "COMPLETED", completedAt: now, startedAt: now, resultRef: task.id } });
    });
    return "CONTINUE";
  }

  if (stepCfg.type === "TIMER") {
    await prisma.$transaction(async (tx) => {
      await createTimerTx(tx, { workflowInstanceId: inst.id, workflowStepId: step.id, kind: "DELAY", availableAt: new Date(now.getTime() + stepCfg.dueAfterSeconds * 1000), idempotencyKey: `${step.id}:timer` });
      await tx.workflowStep.updateMany({ where: { id: step.id, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "WAITING", startedAt: now } });
      await tx.workflowInstance.updateMany({ where: { id: inst.id, claimToken: token }, data: { status: "WAITING", claimToken: null } });
    });
    return "WAIT";
  }

  // ACTION
  await runAction(inst, stepCfg);
  await markCompleted(null);
  return "CONTINUE";
}

async function runAction(
  inst: { id: string; organizationId: string | null; facilityId: string | null; triggerEventId: string; correlationId: string },
  stepCfg: Extract<StepConfig, { type: "ACTION" }>,
): Promise<void> {
  const { name, params } = stepCfg.action;
  if (name === "EMIT_DOMAIN_EVENT") {
    const p = params as { eventType: string; aggregateId?: string; payload?: Record<string, unknown> };
    // Preserve causation: the emitted event shares the instance's correlation chain
    // and names the trigger event as its cause. Depth-capping in
    // startWorkflowsForEvent prevents runaway event→workflow→event loops.
    await emitDomainEvent(prisma, {
      type: p.eventType,
      aggregateId: p.aggregateId ?? inst.id,
      organizationId: inst.organizationId,
      facilityId: inst.facilityId,
      correlationId: inst.correlationId,
      causationId: inst.triggerEventId,
      payload: p.payload ?? {},
    });
    return;
  }
  if (name === "UPDATE_WORKFLOW_STATE") {
    return; // deterministic no-op state marker (a hook for future providers)
  }
  // CREATE_TASK / COMPLETE_TASK / ASSIGN_TASK / START_TIMER are not definition-invokable
  // (the validator rejects them); reaching here would be a programming error.
  throw new Error(`Action ${name} is not invokable from a definition.`);
}

async function handleStepFailure(instanceId: string, stepId: string, attemptCount: number, maxAttempts: number, err: unknown, token: string, now: Date): Promise<void> {
  const { category, message } = classifyWorkflowError(err);
  const canRetry = isRetryable(category) && attemptCount + 1 < Math.min(maxAttempts, LIMITS.MAX_RETRIES);
  if (canRetry) {
    await prisma.workflowStep.updateMany({ where: { id: stepId }, data: { attemptCount: { increment: 1 }, availableAt: stepBackoff(now, attemptCount + 1), failureCategory: category, failureMessage: safeMessage(message) } });
    await prisma.workflowInstance.updateMany({ where: { id: instanceId, claimToken: token }, data: { status: "RUNNABLE", claimToken: null } });
  } else {
    await prisma.workflowStep.updateMany({ where: { id: stepId }, data: { status: "FAILED", attemptCount: { increment: 1 }, failureCategory: category, failureMessage: safeMessage(message) } });
    await prisma.workflowInstance.updateMany({ where: { id: instanceId, claimToken: token }, data: { status: "FAILED", claimToken: null, failedAt: now, failureCategory: category, failureMessage: safeMessage(message) } });
  }
}

// ── Timer tick + runnable sweep (bounded, daemon-free) ───────────────────────

export interface TickOptions { now?: Date; batchSize?: number }
export interface TickResult { timersFired: number; escalated: number; instancesRun: number }

export async function tickWorkflows(opts: TickOptions = {}): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const batchSize = Math.min(Math.max(1, opts.batchSize ?? 100), 500);
  const timers = await processDueWorkflowTimers(now, batchSize);
  const instancesRun = await runRunnableInstances(now, batchSize);
  return { ...timers, instancesRun };
}

async function processDueWorkflowTimers(now: Date, batchSize: number): Promise<{ timersFired: number; escalated: number }> {
  const due = await prisma.workflowTimer.findMany({ where: { status: "PENDING", availableAt: { lte: now } }, orderBy: { availableAt: "asc" }, take: batchSize, select: { id: true } });
  let timersFired = 0, escalated = 0;
  for (const t of due) {
    const token = randomUUID();
    const claim = await prisma.workflowTimer.updateMany({ where: { id: t.id, status: "PENDING" }, data: { status: "CLAIMED", claimToken: token, claimedAt: now, attemptCount: { increment: 1 } } });
    if (claim.count !== 1) continue; // another worker won the claim
    timersFired++;
    const timer = await prisma.workflowTimer.findUniqueOrThrow({ where: { id: t.id } });
    try {
      if (timer.kind === "DELAY") {
        // Complete the waiting step and re-arm the instance.
        if (timer.workflowStepId) await prisma.workflowStep.updateMany({ where: { id: timer.workflowStepId, status: "WAITING" }, data: { status: "COMPLETED", completedAt: now } });
        await prisma.workflowInstance.updateMany({ where: { id: timer.workflowInstanceId, status: "WAITING" }, data: { status: "RUNNABLE" } });
        await prisma.workflowTimer.updateMany({ where: { id: t.id, claimToken: token }, data: { status: "COMPLETED", completedAt: now } });
        await runInstance(timer.workflowInstanceId, { now });
      } else {
        // SLA: escalate only if the guarded task is still unresolved. Idempotent.
        const escalatedNow = await escalateSla(timer);
        if (escalatedNow) escalated++;
        await prisma.workflowTimer.updateMany({ where: { id: t.id, claimToken: token }, data: { status: "COMPLETED", completedAt: now } });
      }
    } catch {
      // Release the claim so a later tick retries this timer (never lost).
      await prisma.workflowTimer.updateMany({ where: { id: t.id, claimToken: token }, data: { status: "PENDING", claimToken: null } });
    }
  }
  return { timersFired, escalated };
}

async function escalateSla(timer: { id: string; workflowInstanceId: string; workflowStepId: string | null; payload: unknown }): Promise<boolean> {
  const payload = (timer.payload ?? {}) as { taskId?: string; escalation?: { taskType: string; title: string; description?: string; priority?: "ROUTINE" | "URGENT" | "STAT"; assignedRole?: string; emitEventType?: string } };
  if (!payload.escalation) return false;
  if (payload.taskId) {
    const task = await prisma.workflowTask.findUnique({ where: { id: payload.taskId }, select: { status: true } });
    if (task && (task.status === "COMPLETED" || task.status === "CANCELLED")) return false; // met SLA — no escalation
  }
  const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: timer.workflowInstanceId }, select: { organizationId: true, facilityId: true } });
  await prisma.$transaction(async (tx) => {
    await createWorkflowTask(tx, {
      workflowInstanceId: timer.workflowInstanceId, workflowStepId: timer.workflowStepId, organizationId: inst.organizationId, facilityId: inst.facilityId,
      taskType: payload.escalation!.taskType, title: payload.escalation!.title, description: payload.escalation!.description ?? null,
      priority: payload.escalation!.priority ?? "URGENT", assignedRole: payload.escalation!.assignedRole ?? null,
      idempotencyKey: `${timer.id}:escalation`,
    });
  });
  return true;
}

async function runRunnableInstances(now: Date, batchSize: number): Promise<number> {
  const runnable = await prisma.workflowInstance.findMany({
    where: { status: "RUNNABLE", steps: { some: { status: "PENDING", OR: [{ availableAt: null }, { availableAt: { lte: now } }] } } },
    orderBy: { createdAt: "asc" }, take: batchSize, select: { id: true },
  });
  let ran = 0;
  for (const i of runnable) { await runInstance(i.id, { now }); ran++; }
  return ran;
}

// ── Context helpers ──────────────────────────────────────────────────────────

function envelopeContext(e: DomainEventEnvelope): WorkflowContext {
  return { event: { type: e.eventType, version: e.eventVersion, aggregateType: e.aggregateType, aggregateId: e.aggregateId, organizationId: e.organizationId, facilityId: e.facilityId, actor: e.actorUserId }, payload: e.payload ?? {} };
}
function instanceContext(inst: { aggregateType: string; aggregateId: string; organizationId: string | null; facilityId: string | null }, payload: Record<string, unknown>, actor: string | null, cfg: WorkflowConfig): WorkflowContext {
  return { event: { type: cfg.trigger.eventType, version: cfg.trigger.eventVersion, aggregateType: inst.aggregateType, aggregateId: inst.aggregateId, organizationId: inst.organizationId, facilityId: inst.facilityId, actor }, payload };
}

export type { FailureCategory };
