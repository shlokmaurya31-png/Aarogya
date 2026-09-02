# Event Architecture (Target Design — Not Implemented)

**Nothing in this document exists in code today.** Aarogya currently has
no event bus, no message queue, no pub/sub layer. What exists is a
**request-scoped write-then-audit** pattern: an API route mutates the
database inside a transaction, then calls `recordAuditEvent()` to write a
row to the shared `AuditEvent` table (see `docs/DATA_MODEL_AUDIT.md` §8).
This is a reasonable, working substitute for an event log at current
scale and is **not being replaced this phase** — this document defines
what a real event architecture should look like *if and when* Aarogya
needs actual event-driven behavior (cross-module reactions, real-time
push, async processing), and explicitly recommends against building
infrastructure ahead of that need.

## 1. Why not build this now

Every "event" the brief's wishlist names (`PATIENT_REGISTERED`,
`CRITICAL_RESULT_DETECTED`, `DISCHARGE_BLOCKED`, etc.) already has a
working synchronous substitute in the current codebase:

- The Command Center's alert feed (`src/lib/hospital/alertEngine.ts`)
  computes "critical result detected," "discharge blocked," "bed
  shortage" etc. by **querying current state on every page load**, not by
  reacting to a stream of events. This works correctly today (verified
  live) and is simpler to reason about than an event-sourced equivalent.
- Audit trail needs are met by `recordAuditEvent()` calls co-located with
  the mutation that caused them — synchronous, transactionally adjacent,
  no risk of a dropped/unprocessed event.

Introducing a real event bus before there's an actual asynchronous
consumer (a notification service, a background job, a webhook to an
external system) would be pure infrastructure with no payoff — exactly
the "do not implement a massive event infrastructure unless necessary"
instruction this document is required to respect.

## 2. When this becomes necessary

A real event architecture earns its cost once any of these appear:

1. **Notification delivery** (SMS/email/push on critical results, task
   overdue, etc. — brief §91) needs to happen *outside* the request that
   caused it (you don't want a lab result API call blocking on an SMS
   provider's response time, and you want retries independent of the
   original request).
2. **Cross-module reactions** where module A's write needs to trigger
   module B's logic without A importing B directly (e.g. "when a bed
   becomes AVAILABLE, notify Housekeeping's queue" — today this is a
   direct function call within the same request; it stays that way until
   Housekeeping is a module with its own deployment/team boundary).
3. **External integrations** (ABDM, insurance clearinghouses, SMS
   gateways) where the hospital's own write shouldn't block on a third
   party's availability.
4. **Analytics/reporting** that wants a durable, replayable stream of
   what happened, independent of current-state queries (e.g. "what was
   bed occupancy at 3pm yesterday" — not answerable from current-state
   queries alone once state has moved on).

None of these exist yet in this codebase. Phase 8 (Command Center +
Analytics) is the earliest point in the roadmap where #4 becomes a real
requirement; Phase 9 (integrations) is where #1 and #3 become real
requirements.

## 3. Target event structure

When built, every event should carry:

```typescript
interface DomainEvent {
  id: string;                    // event id, not the entity's id
  type: string;                  // e.g. "LAB_RESULT_READY" — closed enum, not free text (see §5)
  occurredAt: string;            // ISO timestamp, server clock
  actor: { userId: string; role: string } | { system: string };
  tenant: { organizationId: string; facilityId: string };
  entity: { type: string; id: string };       // what this event is about
  correlationId: string;         // ties together events from one causal chain
  causationId?: string;          // the event/request that directly caused this one
  metadata: Record<string, unknown>;          // event-specific payload
  idempotencyKey?: string;       // see §6
}
```

This deliberately mirrors the shape `AuditEvent` already has
(`type, userId, detail, createdAt`) plus the additions a real event
architecture needs beyond an audit log: `tenant` (for routing/filtering
without a join), `correlationId`/`causationId` (for tracing a causal
chain — e.g. `ORDER_CREATED` → `LAB_SAMPLE_COLLECTED` → `LAB_RESULT_READY`
→ `CRITICAL_RESULT_DETECTED` should all share one `correlationId`), and
`idempotencyKey`.

## 4. Example event catalog (illustrative, not exhaustive)

Grouped by the module that emits them (see `docs/MODULE_BOUNDARIES.md`
for module definitions):

| Module | Events |
|---|---|
| Patient Administration | `PATIENT_REGISTERED`, `PATIENT_IDENTIFIER_LINKED` |
| Scheduling | `APPOINTMENT_CREATED`, `APPOINTMENT_CANCELLED` |
| Admissions | `ENCOUNTER_STARTED`, `BED_RESERVED`, `BED_OCCUPIED`, `PATIENT_TRANSFERRED` |
| Clinical EMR | `NOTE_SIGNED`, `PROBLEM_ADDED`, `ALLERGY_RECORDED` |
| Orders | `ORDER_CREATED`, `ORDER_CANCELLED` |
| Laboratory | `LAB_SAMPLE_COLLECTED`, `LAB_RESULT_READY`, `CRITICAL_RESULT_DETECTED` |
| Radiology | `IMAGING_ACQUIRED`, `IMAGING_REPORT_READY` |
| Pharmacy | `MEDICATION_DISPENSED` |
| Nursing | `MEDICATION_ADMINISTERED`, `TASK_CREATED`, `TASK_OVERDUE` |
| Discharge | `DISCHARGE_REQUESTED`, `DISCHARGE_BLOCKED`, `DISCHARGE_COMPLETED` |
| Billing | `BILL_CREATED`, `CHARGE_ADDED`, `PAYMENT_RECEIVED` |
| Insurance | `CLAIM_SUBMITTED`, `CLAIM_APPROVED`, `CLAIM_REJECTED` |

Every one of these has a **direct current equivalent already happening
synchronously** in the corresponding route handler (e.g.
`CRITICAL_RESULT_DETECTED` ≈ the `LabResult.isCritical: true` write inside
`orders/lab/[id]/result/route.ts`, immediately visible to the alert engine
on next read). The event catalog is a *rename/reification* of behavior
that already exists, not new behavior — this is precisely why building
the bus now would be premature: there's nothing new for it to do yet.

## 5. Design decisions for when this is built

- **Event types as a closed TypeScript union**, not free-text strings —
  unlike `AuditEvent.type` (deliberately open today, see
  `docs/DATA_MODEL_AUDIT.md` §8), a real event bus's routing/subscription
  logic needs a closed set so consumers can exhaustively handle all cases.
- **Outbox pattern**, not a direct publish from the request handler — write
  the event row in the *same* `$transaction()` as the domain mutation
  (guaranteeing the event is never lost if the write succeeds, never
  emitted if it doesn't), then a separate process reads unpublished
  outbox rows and delivers them. This avoids the classic "DB write
  succeeded, event publish failed, now they've diverged" failure mode.
- **`AuditEvent` becomes a projection of the event stream, not a separate
  thing to maintain** — once a real event log exists, the audit trail is
  just "read the event log," removing the current dual-write
  (`recordAuditEvent` calls scattered through 20+ routes) in favor of one
  emission point per domain action.

## 6. Idempotency

Every event **consumer** must be idempotent (processing the same event
twice must not double-apply its effect) — critical for `MEDICATION_ORDERED`,
`CHARGE_ADDED`, `PAYMENT_RECEIVED` specifically, where double-processing
has real financial/clinical consequences. The `idempotencyKey` field
(§3) should default to a deterministic hash of
`(type, entity.id, occurredAt-truncated-to-second)` unless the emitting
route can supply a better natural key (e.g. an external payment gateway's
transaction id).

## 7. What NOT to do

- Do not adopt a message broker (Kafka/RabbitMQ/etc.) before there's a
  real cross-process consumer — a simple outbox table + polling worker
  (or even a cron-triggered batch) is sufficient until Phase 9's external
  integrations genuinely need durable, ordered, multi-consumer delivery.
- Do not retrofit every existing route to publish events "for future
  use" — add event emission when the *first real consumer* is built
  (e.g. the notification engine in Phase 8/9), not speculatively now.
- Do not let this document's existence be read as "events are coming
  soon" — it exists so that when they are needed, the shape is already
  reasoned about, matching this repository's established pattern of
  documenting target architecture ahead of building it (see the
  `ClinicalCaseProvider`/`AIProvider` precedents in Scholar).
