/**
 * Phase D6 — domain-event foundation public surface.
 *
 * Producers import `emitDomainEvent` and call it inside their domain transaction.
 * Operators/routes import the ops/replay/dispatcher functions. See
 * docs/platform/events/ for the architecture, guarantees, and non-guarantees.
 */
export { emitDomainEvent, type EmittedEvent } from "./emit";
export { EVENT_CONTRACTS, ALL_EVENT_TYPES, getEventContract, currentVersion } from "./catalogue";
export { dispatchPendingDomainEvents, type DispatchOptions, type DispatchResult } from "./dispatcher";
export { getEventMetrics, listEvents, getEvent, listDeadLetters, listOrganizationEvents, type EventFilter } from "./ops";
export { replayEvent, retryDeadLetter } from "./replay";
export { requirePlatformEvents, requireOrganizationEvents } from "./authz";
export {
  registerConsumer,
  unregisterConsumer,
  resetConsumers,
  getConsumers,
  getConsumersFor,
  getConsumerNames,
  observabilityProjection,
  type DomainEventConsumer,
} from "./consumers";
export {
  RetryableEventError,
  PermanentEventError,
  classifyEventError,
  type DomainEventEnvelope,
  type EmitEventInput,
  type AggregateType,
  type EventScope,
  type EventSensitivity,
} from "./types";
