/*
  Warnings:

  - You are about to drop the column `imagingOrderId` on the `Order` table. All the data in the column will be lost.
  - You are about to drop the column `labOrderId` on the `Order` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ImagingOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "modality" TEXT NOT NULL,
    "studyDescription" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "orderedByStaffId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ORDERED',
    "orderedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" TEXT,
    CONSTRAINT "ImagingOrder_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImagingOrder_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImagingOrder_orderedByStaffId_fkey" FOREIGN KEY ("orderedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImagingOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ImagingOrder" ("encounterId", "id", "modality", "orderedAt", "orderedByStaffId", "patientId", "priority", "status", "studyDescription") SELECT "encounterId", "id", "modality", "orderedAt", "orderedByStaffId", "patientId", "priority", "status", "studyDescription" FROM "ImagingOrder";
DROP TABLE "ImagingOrder";
ALTER TABLE "new_ImagingOrder" RENAME TO "ImagingOrder";
CREATE UNIQUE INDEX "ImagingOrder_orderId_key" ON "ImagingOrder"("orderId");
CREATE INDEX "ImagingOrder_encounterId_idx" ON "ImagingOrder"("encounterId");
CREATE INDEX "ImagingOrder_status_idx" ON "ImagingOrder"("status");
CREATE TABLE "new_LabOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "testName" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "orderedByStaffId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ORDERED',
    "orderedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" TEXT,
    CONSTRAINT "LabOrder_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LabOrder_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LabOrder_orderedByStaffId_fkey" FOREIGN KEY ("orderedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LabOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_LabOrder" ("category", "encounterId", "id", "orderedAt", "orderedByStaffId", "patientId", "priority", "status", "testName") SELECT "category", "encounterId", "id", "orderedAt", "orderedByStaffId", "patientId", "priority", "status", "testName" FROM "LabOrder";
DROP TABLE "LabOrder";
ALTER TABLE "new_LabOrder" RENAME TO "LabOrder";
CREATE UNIQUE INDEX "LabOrder_orderId_key" ON "LabOrder"("orderId");
CREATE INDEX "LabOrder_encounterId_idx" ON "LabOrder"("encounterId");
CREATE INDEX "LabOrder_status_idx" ON "LabOrder"("status");
CREATE TABLE "new_Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "orderingStaffId" TEXT NOT NULL,
    "orderType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "indication" TEXT,
    "notes" TEXT,
    "startAt" DATETIME,
    "discontinueAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelledReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Order_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_orderingStaffId_fkey" FOREIGN KEY ("orderingStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Order" ("cancelledAt", "cancelledReason", "createdAt", "discontinueAt", "encounterId", "facilityId", "id", "indication", "notes", "orderType", "orderingStaffId", "patientId", "priority", "startAt", "status") SELECT "cancelledAt", "cancelledReason", "createdAt", "discontinueAt", "encounterId", "facilityId", "id", "indication", "notes", "orderType", "orderingStaffId", "patientId", "priority", "startAt", "status" FROM "Order";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
CREATE INDEX "Order_facilityId_idx" ON "Order"("facilityId");
CREATE INDEX "Order_encounterId_idx" ON "Order"("encounterId");
CREATE INDEX "Order_patientId_idx" ON "Order"("patientId");
CREATE INDEX "Order_status_idx" ON "Order"("status");
CREATE INDEX "Order_orderType_idx" ON "Order"("orderType");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
