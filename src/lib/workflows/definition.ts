import { z } from "zod";
import { LIMITS } from "./types";
import { ConditionSchema } from "./conditions";
import { ACTION_NAMES } from "./actions";

/**
 * Phase D7 — the strict, validated workflow definition schema (§28).
 *
 * A definition is a TRIGGER (a D6 event type@version + optional gate condition) and
 * a bounded, ordered pipeline of STEPS. A linear pipeline is a deliberately
 * constrained graph: it is acyclic by construction (no back-edges), which makes
 * loop-prevention (§31) and complexity bounds (§30) trivial to guarantee. A
 * published definition is immutable; changes create a new version.
 */

const positiveDuration = z.number().int().positive().max(LIMITS.MAX_TIMER_SECONDS);
const nodeKey = z.string().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/);

// SLA on a TASK step: a companion timer that, on breach, escalates.
export const EscalationSchema = z.object({
  taskType: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  priority: z.enum(["ROUTINE", "URGENT", "STAT"]).optional(),
  assignedRole: z.string().max(80).optional(),
  emitEventType: z.string().min(1).optional(),
}).strict();

export const SlaSchema = z.object({
  dueAfterSeconds: positiveDuration,
  escalation: EscalationSchema,
}).strict();

const ConditionStep = z.object({
  type: z.literal("CONDITION"),
  key: nodeKey,
  condition: ConditionSchema,
}).strict();

const TaskStep = z.object({
  type: z.literal("TASK"),
  key: nodeKey,
  taskType: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  priority: z.enum(["ROUTINE", "URGENT", "STAT"]).optional(),
  assignedRole: z.string().max(80).optional(),
  dueAfterSeconds: positiveDuration.optional(),
  sla: SlaSchema.optional(),
}).strict();

const TimerStep = z.object({
  type: z.literal("TIMER"),
  key: nodeKey,
  dueAfterSeconds: positiveDuration,
}).strict();

const ActionStep = z.object({
  type: z.literal("ACTION"),
  key: nodeKey,
  action: z.object({
    name: z.enum(ACTION_NAMES),
    params: z.record(z.string(), z.unknown()).default({}),
  }).strict(),
}).strict();

export const StepSchema = z.discriminatedUnion("type", [ConditionStep, TaskStep, TimerStep, ActionStep]);
export type StepConfig = z.infer<typeof StepSchema>;

export const TriggerSchema = z.object({
  eventType: z.string().min(1),
  eventVersion: z.number().int().positive(),
  condition: ConditionSchema.optional(),
}).strict();

export const WorkflowConfigSchema = z.object({
  trigger: TriggerSchema,
  steps: z.array(StepSchema).min(1).max(LIMITS.MAX_STEPS),
}).strict();

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;
