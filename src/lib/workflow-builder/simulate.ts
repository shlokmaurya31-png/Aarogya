import { evaluateCondition, type WorkflowConfig } from "@/lib/workflows";
import type { WorkflowContext } from "@/lib/workflows/types";
import { resolveEffectiveInternal, isKnownConfigKey } from "@/lib/config";

/**
 * Phase D9 — SAFE, side-effect-free workflow simulation (§23/§40).
 *
 * Evaluates trigger matching, the trigger condition, and each step against a
 * SYNTHETIC event, reporting which steps WOULD execute and the SLA that WOULD apply
 * (resolved through the D8 read-only resolver). It creates NO tasks, NO timers, NO
 * records, emits NO domain events, and sends NO notifications — it only reads config.
 */

export interface SimulateInput {
  config: WorkflowConfig;
  synthetic: { payload: Record<string, unknown>; organizationId?: string | null; facilityId?: string | null };
  /** The key the workflow will publish under, for SLA config resolution. */
  workflowKey?: string;
}

export interface SimStep {
  key: string;
  type: string;
  outcome: "WOULD_EXECUTE" | "SKIPPED" | "GATE_NOT_MET";
  detail: string;
  slaSeconds?: number;
  slaSource?: string;
}

export interface SimulationResult {
  simulation: true;
  triggerMatched: boolean;
  triggerConditionMatched: boolean;
  steps: SimStep[];
  notes: string[];
}

export async function simulateWorkflow(input: SimulateInput): Promise<SimulationResult> {
  const cfg = input.config;
  const ctx: WorkflowContext = {
    event: {
      type: cfg.trigger.eventType,
      version: cfg.trigger.eventVersion,
      aggregateType: "SIMULATION",
      aggregateId: "sim",
      organizationId: input.synthetic.organizationId ?? null,
      facilityId: input.synthetic.facilityId ?? null,
      actor: null,
    },
    payload: input.synthetic.payload ?? {},
  };

  const triggerConditionMatched = !cfg.trigger.condition || evaluateCondition(ctx, cfg.trigger.condition);
  const triggerMatched = triggerConditionMatched; // event type/version are the trigger; condition gates it
  const steps: SimStep[] = [];
  const notes = ["SIMULATION — no tasks, timers, records, events, or notifications were created."];

  if (!triggerMatched) {
    for (const s of cfg.steps) steps.push({ key: s.key, type: s.type, outcome: "SKIPPED", detail: "trigger condition not met" });
    return { simulation: true, triggerMatched, triggerConditionMatched, steps, notes };
  }

  let gateFailed = false;
  for (const s of cfg.steps) {
    if (gateFailed) { steps.push({ key: s.key, type: s.type, outcome: "SKIPPED", detail: "a prior condition gate was not met" }); continue; }
    if (s.type === "CONDITION") {
      const pass = evaluateCondition(ctx, s.condition);
      steps.push({ key: s.key, type: s.type, outcome: pass ? "WOULD_EXECUTE" : "GATE_NOT_MET", detail: pass ? "condition matched — continue" : "condition not met — workflow ends here" });
      if (!pass) gateFailed = true;
      continue;
    }
    if (s.type === "TASK") {
      const step: SimStep = { key: s.key, type: s.type, outcome: "WOULD_EXECUTE", detail: `create task "${s.title}" (${s.priority ?? "ROUTINE"}${s.assignedRole ? `, ${s.assignedRole}` : ""})` };
      if (s.sla) {
        let slaSeconds = s.sla.dueAfterSeconds;
        let slaSource = "WORKFLOW_VERSION";
        const cfgKey = input.workflowKey ? `workflow.${input.workflowKey}.sla` : null;
        if (cfgKey && isKnownConfigKey(cfgKey) && ctx.event.organizationId) {
          const eff = await resolveEffectiveInternal({ key: cfgKey, organizationId: ctx.event.organizationId, facilityId: ctx.event.facilityId, fallbackRaw: String(s.sla.dueAfterSeconds) });
          if (typeof eff.value === "number" && eff.value > 0) { slaSeconds = eff.value; slaSource = eff.source; }
        }
        step.slaSeconds = slaSeconds;
        step.slaSource = slaSource;
        step.detail += ` · SLA ${slaSeconds}s (${slaSource})`;
      }
      steps.push(step);
      continue;
    }
    if (s.type === "TIMER") { steps.push({ key: s.key, type: s.type, outcome: "WOULD_EXECUTE", detail: `wait ${s.dueAfterSeconds}s, then resume` }); continue; }
    // ACTION
    steps.push({ key: s.key, type: s.type, outcome: "WOULD_EXECUTE", detail: `action ${s.action.name} (not executed in simulation)` });
  }

  return { simulation: true, triggerMatched, triggerConditionMatched, steps, notes };
}
