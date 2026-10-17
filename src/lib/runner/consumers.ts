import { registerConsumer, getConsumerNames } from "@/lib/events/consumers";
import { workflowConsumer } from "@/lib/workflows/consumer";
import { taskGenerator } from "@/lib/consumers/taskGenerator";
import { marScheduler } from "@/lib/consumers/marScheduler";
import { notificationDispatch } from "@/lib/consumers/notificationDispatch";
import { chargeCapture } from "@/lib/consumers/chargeCapture";
import { stockMovement } from "@/lib/consumers/stockMovement";
import { claimDrafting } from "@/lib/consumers/claimDrafting";
import { dischargeReadiness } from "@/lib/consumers/dischargeReadiness";

/**
 * Workflow spine §3.1 — the one place every domain-event consumer is
 * registered. The runner calls this before dispatching, so no entry point can
 * dispatch without, say, the workflow engine (previously a side-effect import
 * in individual routes). Idempotent: registration is keyed by name.
 */
export const EXPECTED_CONSUMERS = ["observability-projection", "workflow-engine", "task-generator", "mar-scheduler", "notification-dispatch", "charge-capture", "stock-movement", "claim-drafting", "discharge-readiness"] as const;

export function registerAllConsumers(): string[] {
  registerConsumer(workflowConsumer);
  registerConsumer(taskGenerator);
  registerConsumer(marScheduler);
  registerConsumer(notificationDispatch);
  registerConsumer(chargeCapture);
  registerConsumer(stockMovement);
  registerConsumer(claimDrafting);
  registerConsumer(dischargeReadiness);
  return getConsumerNames();
}
