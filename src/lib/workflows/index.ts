/**
 * Phase D7 — workflow engine public surface.
 *
 * Producers of events need do nothing: the `workflow-engine` D6 consumer
 * (registered via `@/lib/workflows/register`) reacts to committed events. Routes
 * and the gate import the management/operations/engine functions below. See
 * docs/platform/workflows/ for the architecture, guarantees, and non-guarantees.
 */
export { validateWorkflowConfig } from "./validator";
export { WorkflowConfigSchema, type WorkflowConfig } from "./definition";
export { evaluateCondition, ConditionSchema, type ConditionNode } from "./conditions";
export { ACTION_REGISTRY, ACTION_NAMES, isKnownAction, isInvokableFromDefinition } from "./actions";
export {
  createDefinition, createVersion, publishVersion, retireDefinition,
  getDefinition, getVersionConfig, listDefinitions,
} from "./definitions";
export { startWorkflowsForEvent, runInstance, tickWorkflows, type TickResult } from "./engine";
export { getInstance, listInstances, cancelInstance, retryInstance } from "./instances";
export { completeWorkflowTask } from "./tasks";
export { getWorkflowMetrics } from "./ops";
export { workflowConsumer } from "./consumer";
export {
  requireWorkflowPlatform, assertCanReadWorkflowScope,
} from "./authz";
export { LIMITS, WorkflowError, classifyWorkflowError, isRetryable, type FailureCategory } from "./types";
