-- Phase D6 — transactional domain-event foundation (SQLite).
-- Strictly additive: two new tables (outbox + per-consumer delivery ledger) and
-- their indexes. No change to any existing table. `status` fields are TEXT and
-- their allowed values are enforced in code (src/lib/events/), matching the D5
-- convention for lifecycle fields.

-- CreateTable
CREATE TABLE "DomainEventOutbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "occurredAt" DATETIME NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "claimToken" TEXT,
    "nextAttemptAt" DATETIME,
    "lastAttemptAt" DATETIME,
    "processedAt" DATETIME,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DomainEventOutbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DomainEventDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "eventId" TEXT NOT NULL,
    "consumerName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "processedAt" DATETIME,
    "lastErrorCode" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DomainEventDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "DomainEventOutbox" ("eventId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "DomainEventOutbox_eventId_key" ON "DomainEventOutbox"("eventId");

-- CreateIndex
CREATE INDEX "DomainEventOutbox_status_nextAttemptAt_idx" ON "DomainEventOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "DomainEventOutbox_eventType_idx" ON "DomainEventOutbox"("eventType");

-- CreateIndex
CREATE INDEX "DomainEventOutbox_aggregateType_aggregateId_idx" ON "DomainEventOutbox"("aggregateType", "aggregateId");

-- CreateIndex
CREATE INDEX "DomainEventOutbox_organizationId_idx" ON "DomainEventOutbox"("organizationId");

-- CreateIndex
CREATE INDEX "DomainEventOutbox_correlationId_idx" ON "DomainEventOutbox"("correlationId");

-- CreateIndex
CREATE INDEX "DomainEventOutbox_occurredAt_idx" ON "DomainEventOutbox"("occurredAt");

-- CreateIndex
CREATE INDEX "DomainEventOutbox_processedAt_idx" ON "DomainEventOutbox"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DomainEventDelivery_eventId_consumerName_key" ON "DomainEventDelivery"("eventId", "consumerName");

-- CreateIndex
CREATE INDEX "DomainEventDelivery_consumerName_status_idx" ON "DomainEventDelivery"("consumerName", "status");

-- CreateIndex
CREATE INDEX "DomainEventDelivery_status_idx" ON "DomainEventDelivery"("status");
