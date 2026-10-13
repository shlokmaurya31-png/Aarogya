-- Phase C3 — ABDM protocol state tracking (PostgreSQL).
-- Mirrors prisma/migrations/20260911150000_phase_c3_abdm_protocol_state.
--
-- Fully ADDITIVE: five nullable columns and one index on an existing table.
-- No table is rebuilt, nothing is dropped or retyped, no row is touched.
--
-- These columns track what the ABDM GATEWAY told us, deliberately separate
-- from HealthInformationExchange.status, which tracks what Aarogya believes.
-- The two legitimately diverge: an exchange authorized locally but never
-- submitted is status=AUTHORIZED / abdmProtocolState=NOT_SUBMITTED, and a
-- patient who declined is DENIED rather than an indistinguishable failure.
-- See src/lib/hospital/interoperability/abdm/protocolState.ts.

-- AlterTable
ALTER TABLE "HealthInformationExchange" ADD COLUMN     "abdmConsentId" TEXT,
ADD COLUMN     "abdmErrorCode" TEXT,
ADD COLUMN     "abdmLastEventAt" TIMESTAMP(3),
ADD COLUMN     "abdmProtocolState" TEXT,
ADD COLUMN     "abdmTransactionId" TEXT;

-- CreateIndex
CREATE INDEX "HealthInformationExchange_abdmConsentId_idx" ON "HealthInformationExchange"("abdmConsentId");
