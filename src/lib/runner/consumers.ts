import { registerConsumer, getConsumerNames } from "@/lib/events/consumers";
import { workflowConsumer } from "@/lib/workflows/consumer";

/**
 * Workflow spine §3.1 — the one place every domain-event consumer is
 * registered. The runner calls this before dispatching, so no entry point can
 * dispatch without, say, the workflow engine (previously a side-effect import
 * in individual routes). Idempotent: registration is keyed by name.
 */
export const EXPECTED_CONSUMERS = ["observability-projection", "workflow-engine"] as const;

export function registerAllConsumers(): string[] {
  registerConsumer(workflowConsumer);
  return getConsumerNames();
}
