# ADR 0004: Modules sync through transactional domain events, not direct calls

- **Status:** Accepted
- **Date:** 2026-10-14

## Context

Aarogya's modules (clinical, pharmacy, inventory, billing, ABDM/NHCX,
workflows, commercial) increasingly react to each other:

- a lab order or dispensed medication creates a charge;
- a medication issue moves stock;
- a payment changes a subscription's state.

Today most of these are **direct cross-module calls inside the caller's
transaction**:

- the lab and imaging order routes, `pharmacy.ts`, `admission.ts` and
  `medicationLifecycle.ts` call `billing/chargeCapture`;
- `pharmacy.ts`, `surgery.ts` and `medicationLifecycle.ts` call
  `inventory/issue` and `inventory/reservation`.

Direct calls couple the modules:

- **One failure blocks the action.** A billing bug can block dispensing a
  medication, because both run in one transaction.
- **Every module must understand every other module's rules.**
- **Adding a reaction means editing the producer.** Every new reaction
  (notify, analytics, ABDM push, workflow) is another edit to the clinical
  code that triggers it.

The infrastructure to do better already exists (Phase D6, `src/lib/events`):

- **Transactional outbox:** `emitDomainEvent(tx, …)` writes a
  `DomainEventOutbox` row in the same transaction as the domain change.
- **Delivery ledger:** a `DomainEventDelivery` row per (event, consumer),
  unique on `(eventId, consumerName)`, with retries, dead-lettering and
  replay.
- **Typed catalogue:** a versioned catalogue of event contracts
  (`catalogue.ts`), with strict Zod schemas.
- **Sensitive-data guard:** `assertNoSensitiveData` keeps notes,
  secrets and identifiers like Aadhaar out of payloads.
- **Workflow engine:** it already starts workflows from events.

It's used for 18 event types (patient, appointment, admission, orders,
results, consent, commercial billing), but not yet for clinical-to-
operational reactions. Week 3 builds those reactions.

## Decision

**When one module needs to react to something another module did, it does
so by consuming a domain event, not through a direct call.**

1. **The producer emits in its own transaction.** The module that owns the
   change calls `emitDomainEvent(tx, …)` with the **same `tx`** as the
   change. If the change commits, the event exists; if it rolls back, the
   event never existed. Never emit through the global client when there's an
   enclosing write. Never call another module's service "after commit"
   instead.
2. **Events carry IDs, not data.** The payload carries:
   - the aggregate ID and related IDs (patient, encounter, facility,
     organization);
   - the minimal non-sensitive metadata needed for routing (type, version,
     occurredAt, correlation and causation IDs).

   It never carries clinical content, names, amounts beyond what a contract
   explicitly declares, or anything `assertNoSensitiveData` rejects.
   **Consumers re-read** what they need through the owning module's service
   and the normal authorization and tenant checks. An event is never a
   shortcut around them.
3. **Consumers are idempotent.** Delivery is at-least-once, so a consumer
   must produce the same end state however many times it runs. Use the
   delivery ledger and natural idempotency keys (for example, charge
   `sourceType` + `sourceId`, or a stock movement keyed by the event ID). Use
   guarded, conditional writes, never "check, then write" without a
   constraint.
4. **Contracts are versioned and append-only.** A new event or a new field
   is a new contract version in `catalogue.ts`. Consumers declare the
   versions they handle. A published version is never changed in a way
   that breaks consumers.
5. **Tenancy comes from the server.** `organizationId`/`facilityId` on an
   event come from server-derived context at emission. A consumer works only
   inside the event's tenant and re-checks it on every row it loads.
6. **Synchronous calls stay only where the user needs the answer now:**
   - authorization and tenancy checks;
   - reads;
   - an invariant that must hold inside the same transaction. For example,
     you can't issue stock that isn't there, so the issue path checks
     availability in the transaction. It doesn't do that through an event.

   These calls go through the owning module's public service functions,
   never its tables.

**Applying it.** New cross-module reactions are built as consumers from now
on, starting in Week 3. The existing direct calls are migrated one at a time
as each area is touched, and each migration keeps its integrity gate green.
The obvious candidates are charge capture from orders, pharmacy and
admission, and stock movements from pharmacy and surgery. There is no big-bang
rewrite.

## Consequences

**Benefits**

- A failure in a downstream module (billing, analytics, ABDM push) no longer
  blocks clinical care. The event waits in the outbox and is retried, or is
  dead-lettered visibly.
- New reactions are new consumers. The producing module isn't edited.
- Every cross-module effect is audited through the outbox and delivery
  ledger, and can be replayed.
- Payloads are IDs only, so the outbox never becomes a second copy of the
  medical record or of secrets. That matters under DPDP.

**Costs and risks**

- **Eventual consistency.** A charge or stock movement appears shortly
  after the clinical action, not in the same transaction. UIs that show both
  must tolerate the gap, and anything that needs them to be atomic stays
  synchronous under rule 6.
- **Idempotency discipline in every consumer.** A non-idempotent consumer
  causes double charges or double stock moves on redelivery. Each consumer
  gets a gate that redelivers the same event and asserts a single effect.
- **More moving parts:** the dispatcher must run, and dead letters need an
  owner. `src/lib/events/ops.ts` already exposes metrics and dead-letter
  listing. Alerting on them is part of Week 3.
- **Re-reading costs a query per consumer.** That's acceptable at hospital
  volumes, and it is what keeps authorization in one place.
