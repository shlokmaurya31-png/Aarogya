# Event Envelope

Every event is stored in `DomainEventOutbox` with a canonical envelope. Business
fields are **immutable** after insert; only operational fields change.

## Fields

| Field | Kind | Meaning |
|---|---|---|
| `eventId` | immutable | Globally-unique public id (distinct from the row `id`) |
| `eventType` | immutable | Stable PascalCase name, e.g. `PatientRegistered` |
| `eventVersion` | immutable | Explicit contract version |
| `aggregateType` | immutable | Canonical entity kind (PATIENT, INVOICE, …) |
| `aggregateId` | immutable | The canonical domain entity id |
| `organizationId` | immutable | Server-derived tenant (null only for platform-scoped) |
| `facilityId` | immutable | Facility scope where applicable |
| `actorUserId` | immutable | User whose action produced it (system events: none) |
| `correlationId` | immutable | Groups events of one business operation |
| `causationId` | immutable | The event/command that caused this one |
| `payload` | immutable | Identifiers + minimal metadata (validated, minimized) |
| `occurredAt` | immutable | Business-event time (UTC) |
| `recordedAt` | immutable | When the row was written (UTC) |
| `status` | operational | PENDING · PROCESSING · PROCESSED · RETRY · DEAD_LETTER |
| `attemptCount` / `maxAttempts` | operational | Bounded retry accounting |
| `claimToken` | operational | Per-claim ownership token |
| `nextAttemptAt` / `lastAttemptAt` / `processedAt` | operational | Scheduling/timing |
| `lastErrorCode` / `lastErrorMessage` | operational | Safe failure info (no payloads/stack traces) |

## Time semantics

`occurredAt` (business time) is distinct from `recordedAt` (write time) and
`processedAt` (delivery time). Processing time is **never** used as business-event
time. All timestamps are UTC.

## Correlation & causation

- `correlationId` ties together events from one causal chain (e.g. an admission →
  bed assignment → first nursing assessment can share one id). It defaults to the
  event's own id when not supplied.
- `causationId` names the specific event/command that directly caused this one.
- Neither is the `eventId`; they are separate lineage fields.

## Ordering

The foundation does **not** promise global ordering. Events from unrelated
aggregates process independently; out-of-order processing must not corrupt
canonical state (canonical state lives in the domain tables, not the event log).
Where ordering matters, partition by `aggregateId`.
