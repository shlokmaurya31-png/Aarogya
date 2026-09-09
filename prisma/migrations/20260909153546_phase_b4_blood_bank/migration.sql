-- CreateTable
CREATE TABLE "BloodProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "componentType" TEXT NOT NULL,
    "defaultUnitDescription" TEXT,
    "storageRequirement" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "itemId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BloodProduct_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BloodProduct_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BloodUnit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "unitNumber" TEXT NOT NULL,
    "aboGroup" TEXT,
    "rhStatus" TEXT,
    "bloodGroupStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "collectedAt" DATETIME,
    "expiresAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'QUARANTINED',
    "itemLotId" TEXT,
    "locationId" TEXT,
    "donorReference" TEXT,
    "sourceOrganization" TEXT,
    "collectionEventRef" TEXT,
    "quarantineReason" TEXT,
    "recalled" BOOLEAN NOT NULL DEFAULT false,
    "recallReason" TEXT,
    "notes" TEXT,
    "registeredByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BloodUnit_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BloodUnit_productId_fkey" FOREIGN KEY ("productId") REFERENCES "BloodProduct" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BloodUnit_itemLotId_fkey" FOREIGN KEY ("itemLotId") REFERENCES "ItemLot" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BloodUnit_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BloodTypingRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT,
    "encounterId" TEXT,
    "unitId" TEXT,
    "aboGroup" TEXT,
    "rhStatus" TEXT,
    "antibodyScreen" TEXT,
    "specimenRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "performedByStaffId" TEXT,
    "verifiedByStaffId" TEXT,
    "verifiedAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BloodTypingRecord_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "BloodUnit" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BloodRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "productId" TEXT,
    "productName" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "indication" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedByStaffId" TEXT NOT NULL,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requiredBy" DATETIME,
    "reviewedByStaffId" TEXT,
    "reviewedAt" DATETIME,
    "approvedByStaffId" TEXT,
    "approvedAt" DATETIME,
    "cancelledReason" TEXT,
    "cancelledAt" DATETIME,
    "emergencyRelease" BOOLEAN NOT NULL DEFAULT false,
    "emergencyReason" TEXT,
    "emergencyAuthorizedByStaffId" TEXT,
    "emergencyAuthorizedAt" DATETIME,
    "surgeryId" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BloodRequest_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BloodRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BloodRequest_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BloodRequest_productId_fkey" FOREIGN KEY ("productId") REFERENCES "BloodProduct" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BloodCompatibilityTest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "unitId" TEXT,
    "testType" TEXT NOT NULL DEFAULT 'CROSSMATCH',
    "aboResult" TEXT,
    "rhResult" TEXT,
    "antibodyScreen" TEXT,
    "crossmatchResult" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "testedByStaffId" TEXT,
    "verifiedByStaffId" TEXT,
    "verifiedAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BloodCompatibilityTest_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BloodRequest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BloodCompatibilityTest_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "BloodUnit" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BloodReservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reservedByStaffId" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "releasedAt" DATETIME,
    "releasedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BloodReservation_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "BloodUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BloodReservation_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BloodRequest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BloodIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "compatibilityTestId" TEXT,
    "emergencyRelease" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "issuedByStaffId" TEXT NOT NULL,
    "issueLocation" TEXT,
    "recipientLocation" TEXT,
    "dispatchedByStaffId" TEXT,
    "dispatchedAt" DATETIME,
    "receivedByStaffId" TEXT,
    "receivedAt" DATETIME,
    "returnedReason" TEXT,
    "returnedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BloodIssue_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "BloodUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "BloodIssue_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BloodRequest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Transfusion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "administeredByStaffId" TEXT,
    "patientIdentityVerified" BOOLEAN NOT NULL DEFAULT false,
    "unitIdentityVerified" BOOLEAN NOT NULL DEFAULT false,
    "productVerified" BOOLEAN NOT NULL DEFAULT false,
    "bloodGroupReviewed" BOOLEAN NOT NULL DEFAULT false,
    "compatibilityReviewed" BOOLEAN NOT NULL DEFAULT false,
    "expiryReviewed" BOOLEAN NOT NULL DEFAULT false,
    "secondCheckStaffId" TEXT,
    "verifiedAt" DATETIME,
    "startedAt" DATETIME,
    "pausedAt" DATETIME,
    "endedAt" DATETIME,
    "stoppedReason" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Transfusion_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transfusion_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "BloodRequest" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Transfusion_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "BloodUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TransfusionObservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "transfusionId" TEXT NOT NULL,
    "observationType" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "recordedByStaffId" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TransfusionObservation_transfusionId_fkey" FOREIGN KEY ("transfusionId") REFERENCES "Transfusion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TransfusionReaction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "transfusionId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REPORTED',
    "reportedByStaffId" TEXT NOT NULL,
    "reportedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "symptoms" TEXT,
    "actionTaken" TEXT,
    "escalationRef" TEXT,
    "resolvedByStaffId" TEXT,
    "resolvedAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "TransfusionReaction_transfusionId_fkey" FOREIGN KEY ("transfusionId") REFERENCES "Transfusion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TransfusionReaction_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "BloodUnit" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BloodProduct_facilityId_idx" ON "BloodProduct"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "BloodProduct_facilityId_code_key" ON "BloodProduct"("facilityId", "code");

-- CreateIndex
CREATE INDEX "BloodUnit_facilityId_status_idx" ON "BloodUnit"("facilityId", "status");

-- CreateIndex
CREATE INDEX "BloodUnit_productId_idx" ON "BloodUnit"("productId");

-- CreateIndex
CREATE INDEX "BloodUnit_expiresAt_idx" ON "BloodUnit"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "BloodUnit_facilityId_unitNumber_key" ON "BloodUnit"("facilityId", "unitNumber");

-- CreateIndex
CREATE INDEX "BloodTypingRecord_facilityId_idx" ON "BloodTypingRecord"("facilityId");

-- CreateIndex
CREATE INDEX "BloodTypingRecord_patientId_idx" ON "BloodTypingRecord"("patientId");

-- CreateIndex
CREATE INDEX "BloodTypingRecord_unitId_idx" ON "BloodTypingRecord"("unitId");

-- CreateIndex
CREATE INDEX "BloodRequest_facilityId_status_idx" ON "BloodRequest"("facilityId", "status");

-- CreateIndex
CREATE INDEX "BloodRequest_patientId_idx" ON "BloodRequest"("patientId");

-- CreateIndex
CREATE INDEX "BloodRequest_encounterId_idx" ON "BloodRequest"("encounterId");

-- CreateIndex
CREATE INDEX "BloodRequest_surgeryId_idx" ON "BloodRequest"("surgeryId");

-- CreateIndex
CREATE INDEX "BloodCompatibilityTest_facilityId_idx" ON "BloodCompatibilityTest"("facilityId");

-- CreateIndex
CREATE INDEX "BloodCompatibilityTest_requestId_idx" ON "BloodCompatibilityTest"("requestId");

-- CreateIndex
CREATE INDEX "BloodCompatibilityTest_unitId_idx" ON "BloodCompatibilityTest"("unitId");

-- CreateIndex
CREATE INDEX "BloodReservation_facilityId_idx" ON "BloodReservation"("facilityId");

-- CreateIndex
CREATE INDEX "BloodReservation_unitId_idx" ON "BloodReservation"("unitId");

-- CreateIndex
CREATE INDEX "BloodReservation_requestId_idx" ON "BloodReservation"("requestId");

-- CreateIndex
CREATE INDEX "BloodReservation_patientId_idx" ON "BloodReservation"("patientId");

-- CreateIndex
CREATE INDEX "BloodIssue_facilityId_idx" ON "BloodIssue"("facilityId");

-- CreateIndex
CREATE INDEX "BloodIssue_unitId_idx" ON "BloodIssue"("unitId");

-- CreateIndex
CREATE INDEX "BloodIssue_requestId_idx" ON "BloodIssue"("requestId");

-- CreateIndex
CREATE INDEX "BloodIssue_patientId_idx" ON "BloodIssue"("patientId");

-- CreateIndex
CREATE INDEX "Transfusion_facilityId_status_idx" ON "Transfusion"("facilityId", "status");

-- CreateIndex
CREATE INDEX "Transfusion_requestId_idx" ON "Transfusion"("requestId");

-- CreateIndex
CREATE INDEX "Transfusion_unitId_idx" ON "Transfusion"("unitId");

-- CreateIndex
CREATE INDEX "Transfusion_patientId_idx" ON "Transfusion"("patientId");

-- CreateIndex
CREATE INDEX "TransfusionObservation_transfusionId_idx" ON "TransfusionObservation"("transfusionId");

-- CreateIndex
CREATE INDEX "TransfusionReaction_facilityId_idx" ON "TransfusionReaction"("facilityId");

-- CreateIndex
CREATE INDEX "TransfusionReaction_transfusionId_idx" ON "TransfusionReaction"("transfusionId");

-- CreateIndex
CREATE INDEX "TransfusionReaction_unitId_idx" ON "TransfusionReaction"("unitId");

-- CreateIndex
CREATE INDEX "TransfusionReaction_patientId_idx" ON "TransfusionReaction"("patientId");
