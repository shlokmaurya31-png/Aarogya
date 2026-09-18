import type { DomainEventConsumer } from "@/lib/events/consumers";
import { startWorkflowsForEvent } from "./engine";

/**
 * Phase D7 — the single D6 consumer that drives the workflow engine. It reuses the
 * D6 dispatcher's at-least-once + idempotent delivery ledger, so it never becomes a
 * second event bus. Instance creation is itself idempotent (`${definitionId}:${eventId}`),
 * so a duplicate event delivery to this consumer cannot create duplicate workflows.
 */
export const workflowConsumer: DomainEventConsumer = {
  name: "workflow-engine",
  handles: "*",
  async handle(event) {
    await startWorkflowsForEvent(event);
  },
};
