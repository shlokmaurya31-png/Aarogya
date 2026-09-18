# Replay & Dead-Letter Retry

Replay is **platform-only, explicit, audited, bounded, and idempotent**.

## What replay does — and does not do

- It creates a new **processing attempt** for an existing event.
- It **never rewrites** the immutable event (type, version, aggregate, organization,
  payload, occurredAt are untouched).
- It **never mutates canonical domain state** — replaying `PaymentReceived` does not
  move money; it only re-runs consumers.
- Because consumers are idempotent, replaying a delivered event does not double-apply
  its effect.

## Operations

- `replayEvent(m, eventId, { consumerName?, reason? })` — resets the targeted
  delivery row(s) to `PENDING` and moves the event to `RETRY`. This is the only
  sanctioned `PROCESSED`/`DEAD_LETTER` → `RETRY` transition. If `consumerName` is
  given, only that consumer re-runs; already-`PROCESSED` consumers stay processed.
- `retryDeadLetter(m, eventId, { reason? })` — valid only from `DEAD_LETTER`; resets
  the dead/failed deliveries and re-enqueues, for use after the underlying cause has
  been corrected.

Both run in a Serializable transaction and record an AuditEvent
(`platform.event.replayed` / `platform.event.deadLetterRetried`) capturing who, which
event, which consumer, when, why, and how many deliveries were reset.

## Concurrency

Concurrent replays converge on the same `PENDING`/`RETRY` state; the dispatcher's
guarded claim ensures a single effective run. Retry + manual retry likewise converge
to one `PROCESSED` result (verified as Races 4 and 5 in the D6 gate).

## API

`POST /api/hospital/enterprise/events/{eventId}/replay` and `…/retry` — both require
`platform:events:operate`. Dead letters are listed at
`GET /api/hospital/enterprise/events/dead-letters`.
