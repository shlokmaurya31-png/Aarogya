-- Phase C2 — ABDM callback ledger (PostgreSQL).
-- Mirrors prisma/migrations/20260911140000_phase_c2_abdm_callback_ledger.
--
-- Fully ADDITIVE: one new table plus its indexes and foreign key. No existing
-- table is rebuilt, no column dropped or retyped, no clinical row touched.
--
-- The unique index on (facilityId, callbackKind, externalRequestId) IS the
-- replay-protection mechanism for inbound ABDM callbacks: a replayed callback
-- collides on insert instead of being processed a second time. It is enforced
-- by the database rather than by application logic precisely because the
-- callback endpoint is publicly reachable and concurrent deliveries are
-- expected. See src/lib/hospital/interoperability/abdm/callbacks.ts.

-- CreateTable
CREATE TABLE "AbdmCallbackEvent" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "callbackKind" TEXT NOT NULL,
    "externalRequestId" TEXT NOT NULL,
    "correlationId" TEXT,
    "exchangeId" TEXT,
    "consentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACCEPTED',
    "rejectionReason" TEXT,
    "payloadHash" TEXT,
    "payloadBytes" INTEGER,
    "sourceAddress" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "AbdmCallbackEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AbdmCallbackEvent_facilityId_status_idx" ON "AbdmCallbackEvent"("facilityId", "status");

-- CreateIndex
CREATE INDEX "AbdmCallbackEvent_exchangeId_idx" ON "AbdmCallbackEvent"("exchangeId");

-- CreateIndex
CREATE UNIQUE INDEX "AbdmCallbackEvent_facilityId_callbackKind_externalRequestId_key" ON "AbdmCallbackEvent"("facilityId", "callbackKind", "externalRequestId");

-- AddForeignKey
ALTER TABLE "AbdmCallbackEvent" ADD CONSTRAINT "AbdmCallbackEvent_exchangeId_fkey" FOREIGN KEY ("exchangeId") REFERENCES "HealthInformationExchange"("id") ON DELETE SET NULL ON UPDATE CASCADE;
