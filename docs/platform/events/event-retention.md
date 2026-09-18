# Retention

D6 does **not** implement automated archival or purge — it defines the policy and
the boundary.

## Principles

- The outbox is the initial durable boundary. Events are **not** deleted merely to
  reduce database size before a proper retention strategy exists.
- Immutable business facts are never rewritten; retention concerns whole-row
  lifecycle, not field edits.
- Privacy: payloads already carry only identifiers + minimal metadata (no PHI beyond
  references, no secrets), so retained events are not a shadow copy of the record.

## Operational vs archival (future)

| Tier | Intent | Status |
|---|---|---|
| Operational | Recent events for dispatch, replay, dead-letter triage, metrics | Live in `DomainEventOutbox` |
| Archival | Long-term/warehouse export for analytics | **Deferred** — the outbox is the boundary a future warehouse/export path consumes |

## Future warehouse / export path

The outbox is deliberately the single boundary from which a later system
(notifications, workflow, analytics, data warehouse) can consume — **without** CDC,
Debezium, Kafka, or partitioning introduced prematurely. When a real retention/export
requirement appears, it reads from this boundary; no domain service is rewritten.

## Dead letters

Dead-lettered events are retained for operator inspection and retry after correction.
They are never silently deleted.
