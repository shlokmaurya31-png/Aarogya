# Domain Event Foundation (Phase D6)

Aarogya has a **transactional domain-event foundation** inside the existing
modular monolith. It lets future systems reliably react to business facts —
`PatientRegistered`, `PaymentReceived`, `LabResultReleased` — **once, durably,
immutably, and tenant-safely**, without turning Aarogya into a distributed
system.

This is **not** an event bus, message broker, event-sourced database, or CQRS
rewrite. It is a durable in-database boundary that a later platform (notifications,
workflow, analytics, integrations) can consume.

## The guarantee

```
DOMAIN COMMAND → DOMAIN TRANSACTION → STATE CHANGE + OUTBOX EVENT (one commit)
                                        ↓
                                   DISPATCHER → CONSUMERS
```

- **If the domain transaction commits, the event exists.**
- **If the domain transaction rolls back, the event does not exist.**

Events are written to the `DomainEventOutbox` in the **same** `$transaction` as the
mutation they describe (see `src/lib/events/emit.ts`). A separate dispatcher later
claims and delivers them.

## What it is / isn't

| Is | Isn't |
|---|---|
| Transactional outbox in Postgres/SQLite | Kafka / RabbitMQ / NATS / Redis Streams |
| At-least-once delivery + idempotent consumers | Exactly-once magic |
| Facts emitted FROM canonical state | Event sourcing (canonical state stays in domain tables) |
| Read models for event operations | CQRS rewrite of clinical/commercial reads |
| In-monolith service boundary | Microservices / service mesh / external broker |

## Domain event vs audit event

- **AuditEvent** answers *who did what* (`Dr Smith updated encounter`).
- **DomainEvent** answers *what happened in the business domain* (`EncounterCreated`).

They are related but not interchangeable. AuditEvent is **not** removed or replaced,
and normal event creation/dispatch is **not** mirrored into the audit log. Only
operator interventions on the event stream (replay, dead-letter retry) are audited.

## Module map (`src/lib/events/`)

| File | Responsibility |
|---|---|
| `catalogue.ts` | Versioned, `.strict()` event contracts (the schema registry) |
| `emit.ts` | The single emission point — validates + writes the outbox row in-tx |
| `sensitiveGuard.ts` | Type-agnostic data-minimization barrier (no secrets/PHI) |
| `dispatcher.ts` | Claims events, delivers to consumers, retries, dead-letters, isolates poison |
| `consumers.ts` | Consumer registry + the reference observability consumer |
| `replay.ts` | Platform-only controlled replay + dead-letter retry (audited) |
| `ops.ts` | Platform metrics/list/get + tenant-scoped org event reads |
| `authz.ts` | `platform:events:operate` gate + tenant read gate |
| `tenant.ts` | Server-side facility→organization resolution for facility-scoped events |

## Verification

- Contract tests: `src/lib/events/events.test.ts` (vitest).
- Transactional + concurrency + security gate: `scripts/verify-postgres-d6-events.ts`
  (PostgreSQL: 25 checks incl. 6 races; SQLite: 20, concurrency skipped by design).

See the sibling docs: [catalogue](event-catalogue.md), [envelope](event-envelope.md),
[versioning](event-versioning.md), [security](event-security.md),
[delivery](event-delivery.md), [replay](event-replay.md), [retention](event-retention.md).
