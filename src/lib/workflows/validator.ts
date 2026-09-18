import { BadRequestError } from "@/lib/auth/rbac";
import { getEventContract, currentVersion } from "@/lib/events/catalogue";
import { WorkflowConfigSchema, type WorkflowConfig } from "./definition";
import { assertConditionBounds } from "./conditions";
import { ACTION_REGISTRY, isInvokableFromDefinition } from "./actions";
import { LIMITS } from "./types";

/**
 * Phase D7 — publication-time validator (§29).
 *
 * A workflow definition must be fully validated BEFORE it can be published; an
 * invalid definition never reaches execution. This rejects unknown trigger events/
 * versions, unknown condition operators, unknown/inaccessible actions, malformed or
 * over-large graphs, invalid durations, and unsafe field paths. It returns the
 * strongly-typed, normalized config on success and throws a 400-shaped
 * BadRequestError with a clear message otherwise.
 */
export function validateWorkflowConfig(raw: unknown): WorkflowConfig {
  const parsed = WorkflowConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestError(`Invalid workflow definition: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  }
  const cfg = parsed.data;

  // Trigger must reference a known D6 event contract (type@version).
  if (!getEventContract(cfg.trigger.eventType, cfg.trigger.eventVersion)) {
    throw new BadRequestError(`Unknown trigger event ${cfg.trigger.eventType}@${cfg.trigger.eventVersion}.`);
  }
  if (cfg.trigger.condition) assertConditionBounds(cfg.trigger.condition);

  if (cfg.steps.length > LIMITS.MAX_STEPS) throw new BadRequestError(`Workflow exceeds ${LIMITS.MAX_STEPS} steps.`);

  const keys = new Set<string>();
  for (const step of cfg.steps) {
    if (keys.has(step.key)) throw new BadRequestError(`Duplicate step key "${step.key}".`);
    keys.add(step.key);

    if (step.type === "CONDITION") {
      assertConditionBounds(step.condition);
    } else if (step.type === "ACTION") {
      if (!isInvokableFromDefinition(step.action.name)) {
        throw new BadRequestError(`Action "${step.action.name}" cannot be invoked from a workflow definition.`);
      }
      const spec = ACTION_REGISTRY[step.action.name];
      const p = spec.paramsSchema.safeParse(step.action.params);
      if (!p.success) throw new BadRequestError(`Invalid params for action ${step.action.name}: ${p.error.issues.map((i) => i.message).join("; ")}`);
      // A definition-emitted event must itself target a known catalogue event.
      if (step.action.name === "EMIT_DOMAIN_EVENT") {
        const et = (p.data as { eventType: string }).eventType;
        if (currentVersion(et) === undefined) throw new BadRequestError(`EMIT_DOMAIN_EVENT targets unknown event "${et}".`);
      }
    } else if (step.type === "TASK") {
      if (step.sla && step.sla.escalation.emitEventType && currentVersion(step.sla.escalation.emitEventType) === undefined) {
        throw new BadRequestError(`SLA escalation targets unknown event "${step.sla.escalation.emitEventType}".`);
      }
    }
    // TIMER durations are bounded by the schema (positive, <= MAX_TIMER_SECONDS).
  }

  return cfg;
}
