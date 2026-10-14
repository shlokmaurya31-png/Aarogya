-- CreateTable
CREATE TABLE "AbdmCallbackEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME,
    CONSTRAINT "AbdmCallbackEvent_exchangeId_fkey" FOREIGN KEY ("exchangeId") REFERENCES "HealthInformationExchange" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AbdmCallbackEvent_facilityId_status_idx" ON "AbdmCallbackEvent"("facilityId", "status");

-- CreateIndex
CREATE INDEX "AbdmCallbackEvent_exchangeId_idx" ON "AbdmCallbackEvent"("exchangeId");

-- CreateIndex
CREATE UNIQUE INDEX "AbdmCallbackEvent_facilityId_callbackKind_externalRequestId_key" ON "AbdmCallbackEvent"("facilityId", "callbackKind", "externalRequestId");
