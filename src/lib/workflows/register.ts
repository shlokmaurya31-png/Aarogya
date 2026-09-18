import { registerConsumer } from "@/lib/events/consumers";
import { workflowConsumer } from "./consumer";

/**
 * Phase D7 — side-effect module that registers the workflow consumer with the D6
 * dispatcher. Import `@/lib/workflows/register` from any entry point that dispatches
 * events (the D6 dispatch route, workflow routes, tests/gate) so the consumer is
 * present whenever dispatch runs. Dependency direction is workflows → events only;
 * the events layer never imports workflows.
 */
registerConsumer(workflowConsumer);
