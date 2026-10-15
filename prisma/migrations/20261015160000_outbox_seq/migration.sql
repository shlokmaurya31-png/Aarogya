-- Workflow spine §3.3: events are claimed in insert order, per aggregate.
-- occurredAt can't order events from one transaction (now() is the
-- transaction's start time), so the outbox gets a monotonic sequence.
-- Existing rows are numbered in physical order when the column is added.
ALTER TABLE "DomainEventOutbox" ADD COLUMN "seq" BIGINT GENERATED ALWAYS AS IDENTITY;

-- The claim's ordering lookup: "is there an older unfinished event for this
-- aggregate?" Partial, so finished events don't grow it.
CREATE INDEX "DomainEventOutbox_unfinished_aggregate_seq_idx"
  ON "DomainEventOutbox" ("aggregateType", "aggregateId", "seq")
  WHERE "status" IN ('PENDING', 'RETRY', 'PROCESSING');

-- The claim scans eligible events in seq order.
CREATE INDEX "DomainEventOutbox_eligible_seq_idx"
  ON "DomainEventOutbox" ("seq")
  WHERE "status" IN ('PENDING', 'RETRY');
