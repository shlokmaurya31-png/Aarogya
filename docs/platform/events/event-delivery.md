# Delivery, Dispatch & Reliability

## Dispatcher

`dispatchPendingDomainEvents({ batchSize, maxDurationMs, now })` claims eligible
events and delivers each to every registered consumer. It is **bounded** (batch size
+ max duration) and requires **no daemon** — correctness never depends on a process
running continuously. It can be driven by a scheduler, worker, CLI, or the
platform-only `POST /api/hospital/enterprise/events/dispatch` endpoint. D6 ships no
automated scheduler.

## Concurrency-safe claim

An event is claimed with a guarded conditional `UPDATE` that matches
`status IN (PENDING, RETRY)` and sets `PROCESSING` + a per-claim token, incrementing
`attemptCount`. Only one worker's update matches; the rest move on. This is safe on
**both** PostgreSQL and SQLite without `SELECT … FOR UPDATE`. Finalization is guarded
by the same claim token so only the owner writes the outcome.

## At-least-once + idempotent consumers

Delivery is **at-least-once**; there is no exactly-once magic. Each `(eventId,
consumerName)` has one `DomainEventDelivery` row (unique). A consumer with a
`PROCESSED` delivery is never re-invoked, and a `DEAD_LETTER` delivery is never
retried. **Every consumer must be idempotent** — processing the same event twice
must not double-apply its effect.

## Retry policy

- Errors are classified (`classifyEventError`): explicit `PermanentEventError` /
  4xx-shaped errors are **not** retried; `RetryableEventError` and unknown errors are
  retried up to the event's `maxAttempts` (default 8) with exponential backoff
  (30s base, 1h cap), then dead-lettered.
- A schema-invalid or unknown-type event is **poison**: dead-lettered immediately
  (non-retryable) so it never blocks the queue for valid events.

## Failure semantics

| Failure | Outcome |
|---|---|
| Domain transaction fails | No event (never written) |
| Outbox write fails | Domain transaction rolls back |
| Dispatcher dies mid-flight | Event stays PROCESSING → re-eligible (claim token stale); worst case redelivered (idempotent) |
| Consumer transient failure | Delivery FAILED → event RETRY with backoff |
| Consumer permanent failure / attempts exhausted | Delivery + event DEAD_LETTER |
| Duplicate delivery | Consumer idempotency → one effect |

A downstream consumer failing (analytics, notifications) **never** rolls back or
invalidates the canonical clinical/financial record — see the safety principles in
the phase report.

## Observability & health thresholds

`getEventMetrics` reports counts by status/type, delivery health, dead-letter count,
oldest pending age, and average processing latency (event-system metrics, **not**
business KPIs). Documented thresholds:

| Signal | ATTENTION | CRITICAL |
|---|---|---|
| Oldest pending event age | ≥ 5 min | ≥ 1 h |
| Dead-letter count | ≥ 1 | ≥ 25 |
