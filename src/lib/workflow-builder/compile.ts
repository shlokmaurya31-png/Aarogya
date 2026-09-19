import { BadRequestError } from "@/lib/auth/rbac";
import { validateWorkflowConfig, type WorkflowConfig } from "@/lib/workflows";
import type { BuilderDocument } from "./document";

/**
 * Phase D9 — compile a builder document into the CANONICAL D7 workflow config, then
 * run it through the authoritative D7 validator. There is no separate execution
 * format: the builder's trigger/steps ARE the canonical shapes (layout metadata is
 * dropped). Publishing/simulation/validation all go through this one compiler so the
 * backend stays authoritative (§3/§18).
 */

export class BuilderIncompleteError extends BadRequestError {
  constructor(message: string) {
    super(message);
    this.name = "BuilderIncompleteError";
  }
}

/** Compile → canonical config. Throws BuilderIncompleteError / BadRequestError. */
export function compileBuilderDocument(doc: BuilderDocument): WorkflowConfig {
  if (!doc.trigger || Object.keys(doc.trigger).length === 0) throw new BuilderIncompleteError("A trigger is required to publish this workflow.");
  if (!doc.steps || doc.steps.length === 0) throw new BuilderIncompleteError("At least one step is required to publish this workflow.");
  const candidate = { trigger: doc.trigger, steps: doc.steps };
  // The D7 validator is authoritative: unknown trigger event/version, unknown
  // action/operator, malformed graph, bad durations, over-nesting, etc. are all
  // rejected here — the builder cannot bypass it.
  return validateWorkflowConfig(candidate);
}

export interface ValidationSection { label: string; ok: boolean; detail: string }
export interface ValidationReport {
  valid: boolean;
  sections: ValidationSection[];
  errors: string[];
}

/** A structured validation report for the builder UI (§36). Advisory in the UI;
 * the same compiler runs server-side before any publish. */
export function buildValidationReport(doc: BuilderDocument): ValidationReport {
  const sections: ValidationSection[] = [];
  const errors: string[] = [];
  let config: WorkflowConfig | null = null;
  try {
    config = compileBuilderDocument(doc);
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  if (config) {
    sections.push({ label: "Trigger", ok: true, detail: `${config.trigger.eventType}@${config.trigger.eventVersion}` });
    sections.push({ label: "Trigger condition", ok: true, detail: config.trigger.condition ? "1 condition gate" : "none (always matches)" });
    const conditions = config.steps.filter((s) => s.type === "CONDITION").length;
    const tasks = config.steps.filter((s) => s.type === "TASK").length;
    const timers = config.steps.filter((s) => s.type === "TIMER").length;
    const actions = config.steps.filter((s) => s.type === "ACTION").length;
    const slas = config.steps.filter((s) => s.type === "TASK" && (s as { sla?: unknown }).sla).length;
    sections.push({ label: "Steps", ok: true, detail: `${config.steps.length} step(s): ${tasks} task, ${timers} timer, ${actions} action, ${conditions} condition` });
    sections.push({ label: "SLA", ok: true, detail: slas > 0 ? `${slas} task SLA(s)` : "none" });
    sections.push({ label: "Security", ok: true, detail: "only allow-listed events/actions/operators; no code/SQL" });
  } else {
    sections.push({ label: "Definition", ok: false, detail: errors[0] ?? "invalid" });
  }
  return { valid: config !== null, sections, errors };
}

// ── Semantic version diff (§33) ──────────────────────────────────────────────
export interface ConfigDiff {
  triggerChanged: boolean;
  triggerBefore: string | null;
  triggerAfter: string | null;
  addedSteps: string[];
  removedSteps: string[];
  changedSteps: { key: string; detail: string }[];
}

const stepKey = (s: WorkflowConfig["steps"][number]) => s.key;

export function diffConfigs(before: WorkflowConfig | null, after: WorkflowConfig): ConfigDiff {
  const b = before;
  const trigBefore = b ? `${b.trigger.eventType}@${b.trigger.eventVersion}` : null;
  const trigAfter = `${after.trigger.eventType}@${after.trigger.eventVersion}`;
  const beforeSteps = new Map((b?.steps ?? []).map((s) => [stepKey(s), s]));
  const afterSteps = new Map(after.steps.map((s) => [stepKey(s), s]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: { key: string; detail: string }[] = [];
  for (const [k, s] of afterSteps) {
    if (!beforeSteps.has(k)) added.push(`${s.type}:${k}`);
    else if (JSON.stringify(beforeSteps.get(k)) !== JSON.stringify(s)) changed.push({ key: k, detail: `${s.type} step changed` });
  }
  for (const [k, s] of beforeSteps) if (!afterSteps.has(k)) removed.push(`${s.type}:${k}`);
  return { triggerChanged: trigBefore !== trigAfter, triggerBefore: trigBefore, triggerAfter: trigAfter, addedSteps: added, removedSteps: removed, changedSteps: changed };
}
