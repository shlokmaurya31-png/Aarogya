-- Phase D6 — transactional domain-event foundation (PostgreSQL).
-- Mirrors prisma/migrations/20260918100000_phase_d6_domain_event_outbox.
--
-- Strictly additive: two new tables (the transactional outbox + a per-consumer
-- delivery/idempotency ledger) with their indexes and foreign keys. No DROP, no
-- retype, no data change, no enum. `status` fields are TEXT (allowed values
-- enforced in code), matching the D5 convention so both trees are identical here.

-- CreateTable
CREATE TABLE "DomainEventOutbox" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventVersion" INTEGER NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "organizationId" TEXT,
    "facilityId" TEXT,
    "actorUserId" TEXT,
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "payload" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "claimToken" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainEventOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainEventDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "consumerName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DomainEventDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DomainEventOutbox_eventId_key" ON "DomainEventOutbox"("eventId");
CREATE INDEX "DomainEventOutbox_status_nextAttemptAt_idx" ON "DomainEventOutbox"("status", "nextAttemptAt");
CREATE INDEX "DomainEventOutbox_eventType_idx" ON "DomainEventOutbox"("eventType");
CREATE INDEX "DomainEventOutbox_aggregateType_aggregateId_idx" ON "DomainEventOutbox"("aggregateType", "aggregateId");
CREATE INDEX "DomainEventOutbox_organizationId_idx" ON "DomainEventOutbox"("organizationId");
CREATE INDEX "DomainEventOutbox_correlationId_idx" ON "DomainEventOutbox"("correlationId");
CREATE INDEX "DomainEventOutbox_occurredAt_idx" ON "DomainEventOutbox"("occurredAt");
CREATE INDEX "DomainEventOutbox_processedAt_idx" ON "DomainEventOutbox"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DomainEventDelivery_eventId_consumerName_key" ON "DomainEventDelivery"("eventId", "consumerName");
CREATE INDEX "DomainEventDelivery_consumerName_status_idx" ON "DomainEventDelivery"("consumerName", "status");
CREATE INDEX "DomainEventDelivery_status_idx" ON "DomainEventDelivery"("status");

-- AddForeignKey
ALTER TABLE "DomainEventOutbox" ADD CONSTRAINT "DomainEventOutbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainEventDelivery" ADD CONSTRAINT "DomainEventDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "DomainEventOutbox"("eventId") ON DELETE CASCADE ON UPDATE CASCADE;
