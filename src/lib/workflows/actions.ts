import { z } from "zod";

/**
 * Phase D7 — the action registry (§10).
 *
 * Workflow definitions can NEVER call arbitrary functions. Every action is
 * allow-listed here with a strict parameter schema. Execution lives in the engine
 * (engine.ts / tasks.ts / timers.ts) and always runs through existing domain
 * services with their normal authorization/tenant/audit controls — the engine is
 * orchestration, never a privilege-escalation or clinical-authority path.
 *
 * `invokableFromDefinition` marks the actions an ACTION step may name directly.
 * CREATE_TASK / START_TIMER are driven by the first-class TASK / TIMER step types
 * (and by SLA escalation) rather than named in raw ACTION steps; COMPLETE_TASK /
 * ASSIGN_TASK are operator/task-service actions, not definition-authored.
 */

export const ACTION_NAMES = [
  "CREATE_TASK",
  "COMPLETE_TASK",
  "ASSIGN_TASK",
  "START_TIMER",
  "EMIT_DOMAIN_EVENT",
  "UPDATE_WORKFLOW_STATE",
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

// Parameter schemas for the actions an ACTION step may name.
export const EmitDomainEventParams = z.object({
  eventType: z.string().min(1),
  aggregateId: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const UpdateWorkflowStateParams = z.object({
  note: z.string().max(500).optional(),
}).strict();

export interface ActionSpec {
  name: ActionName;
  invokableFromDefinition: boolean;
  paramsSchema: z.ZodTypeAny;
}

export const ACTION_REGISTRY: Record<ActionName, ActionSpec> = {
  CREATE_TASK: { name: "CREATE_TASK", invokableFromDefinition: false, paramsSchema: z.any() },
  COMPLETE_TASK: { name: "COMPLETE_TASK", invokableFromDefinition: false, paramsSchema: z.any() },
  ASSIGN_TASK: { name: "ASSIGN_TASK", invokableFromDefinition: false, paramsSchema: z.any() },
  START_TIMER: { name: "START_TIMER", invokableFromDefinition: false, paramsSchema: z.any() },
  EMIT_DOMAIN_EVENT: { name: "EMIT_DOMAIN_EVENT", invokableFromDefinition: true, paramsSchema: EmitDomainEventParams },
  UPDATE_WORKFLOW_STATE: { name: "UPDATE_WORKFLOW_STATE", invokableFromDefinition: true, paramsSchema: UpdateWorkflowStateParams },
};

export function isKnownAction(name: string): name is ActionName {
  return (ACTION_NAMES as readonly string[]).includes(name);
}
export function isInvokableFromDefinition(name: string): boolean {
  return isKnownAction(name) && ACTION_REGISTRY[name].invokableFromDefinition;
}
