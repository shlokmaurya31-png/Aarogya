-- AlterTable
ALTER TABLE "HealthInformationExchange" ADD COLUMN "abdmConsentId" TEXT;
ALTER TABLE "HealthInformationExchange" ADD COLUMN "abdmErrorCode" TEXT;
ALTER TABLE "HealthInformationExchange" ADD COLUMN "abdmLastEventAt" DATETIME;
ALTER TABLE "HealthInformationExchange" ADD COLUMN "abdmProtocolState" TEXT;
ALTER TABLE "HealthInformationExchange" ADD COLUMN "abdmTransactionId" TEXT;

-- CreateIndex
CREATE INDEX "HealthInformationExchange_abdmConsentId_idx" ON "HealthInformationExchange"("abdmConsentId");
