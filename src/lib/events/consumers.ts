import type { DomainEventEnvelope } from "./types";

/**
 * Phase D6 — consumer registry.
 *
 * A consumer reacts to a delivered event. The dispatcher (dispatcher.ts) invokes
 * each registered consumer at MOST once effectively per event, backed by a unique
 * (eventId, consumerName) delivery row — delivery is at-least-once, so every
 * consumer MUST be idempotent (processing the same event twice must not double
 * apply its effect). A consumer must confine itself to its own concern and MUST
 * NOT use event metadata to bypass tenant/C4 authorization on other domains.
 *
 * D6 ships ONE reference consumer that proves the framework end-to-end without
 * building any communication/analytics infrastructure (those belong to a later
 * platform phase and simply register here when they exist).
 */

export interface DomainEventConsumer {
  /** Stable, unique name — also the delivery-ledger key. */
  name: string;
  /** Event types handled, or "*" for all. */
  handles: readonly string[] | "*";
  /** React to one event. Throw to signal failure (see classifyEventError). */
  handle(event: DomainEventEnvelope): Promise<void>;
}

const registry = new Map<string, DomainEventConsumer>();

export function registerConsumer(consumer: DomainEventConsumer): void {
  registry.set(consumer.name, consumer);
}
export function unregisterConsumer(name: string): void {
  registry.delete(name);
}
export function getConsumers(): DomainEventConsumer[] {
  return [...registry.values()];
}
export function getConsumersFor(eventType: string): DomainEventConsumer[] {
  return getConsumers().filter((c) => c.handles === "*" || c.handles.includes(eventType));
}
export function getConsumerNames(): string[] {
  return [...registry.keys()].sort();
}

/**
 * Reference consumer: a deterministic, side-effect-free projection that simply
 * confirms an event was delivered. It proves at-least-once delivery, idempotent
 * consumption, retry and dead-letter mechanics without touching any other domain.
 * Real consumers (notification preparation, analytics projections) register the
 * same way once those subsystems exist.
 */
export const observabilityProjection: DomainEventConsumer = {
  name: "observability-projection",
  handles: "*",
  async handle(_event: DomainEventEnvelope): Promise<void> {
    // Intentionally no side effect: the delivery record itself IS the projection
    // of "this event was observed by the platform". Idempotent by construction.
    return;
  },
};

/** (Re)install the built-in consumers. Called at load and by tests after resets. */
export function registerBuiltInConsumers(): void {
  registerConsumer(observabilityProjection);
}

/** Test helper: clear the registry and restore only the built-ins. */
export function resetConsumers(): void {
  registry.clear();
  registerBuiltInConsumers();
}

registerBuiltInConsumers();
