import type { z } from "zod";
import { EVENT_CONTRACTS } from "@/lib/events/catalogue";
import { ACTION_NAMES, isInvokableFromDefinition, LIMITS } from "@/lib/workflows";
import { OPERATORS } from "@/lib/workflows/conditions";

/**
 * Phase D9 — builder metadata, generated from the CANONICAL sources so the UI never
 * hard-codes a parallel list (§6/§8/§10): triggers come from the D6 event catalogue,
 * actions from the D7 registry, operators from the D7 condition engine, limits from
 * D7. Unknown events/actions/operators are therefore impossible to offer or publish.
 */

function payloadFields(payload: z.ZodTypeAny): string[] {
  const shape = (payload as unknown as { shape?: Record<string, unknown> }).shape;
  if (!shape || typeof shape !== "object") return [];
  return Object.keys(shape).map((k) => `payload.${k}`);
}

export function builderMetadata() {
  return {
    triggers: EVENT_CONTRACTS.map((c) => ({
      eventType: c.type,
      eventVersion: c.version,
      aggregateType: c.aggregateType,
      scope: c.scope,
      sensitivity: c.sensitivity,
      // The allow-listed condition context available for this trigger (§7).
      context: ["event.type", "event.aggregateType", "event.aggregateId", "event.organizationId", "event.facilityId", ...payloadFields(c.payload)],
    })),
    // Actions a builder ACTION step may name (task/timer are first-class step types).
    actions: ACTION_NAMES.filter((n) => isInvokableFromDefinition(n)),
    stepTypes: ["CONDITION", "TASK", "TIMER", "ACTION"] as const,
    operators: OPERATORS,
    conditionGroups: ["all", "any", "not"] as const,
    priorities: ["ROUTINE", "URGENT", "STAT"] as const,
    limits: {
      maxSteps: LIMITS.MAX_STEPS,
      maxConditionDepth: LIMITS.MAX_CONDITION_DEPTH,
      maxConditionNodes: LIMITS.MAX_CONDITION_NODES,
      maxTimerSeconds: LIMITS.MAX_TIMER_SECONDS,
    },
  };
}
