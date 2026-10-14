-- Phase E1 — Hospital Notification Center (SQLite).
-- Strictly additive: one new table (Notification) holding a per-recipient,
-- tenant-scoped notification stream. No existing table or column is touched.
-- Status/priority/category are TEXT (values enforced in code, per the D5–D9
-- convention). patientId/encounterId are plain nullable strings so this
-- model needs no back-relation on Patient.

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "recipientStaffId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'OPERATIONAL',
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "linkHref" TEXT,
    "patientId" TEXT,
    "encounterId" TEXT,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "createdByStaffId" TEXT,
    "readAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Notification_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Notification_recipientStaffId_fkey" FOREIGN KEY ("recipientStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Notification_recipientStaffId_idx" ON "Notification"("recipientStaffId");
CREATE INDEX "Notification_facilityId_idx" ON "Notification"("facilityId");
CREATE INDEX "Notification_recipientStaffId_readAt_idx" ON "Notification"("recipientStaffId", "readAt");
CREATE INDEX "Notification_recipientStaffId_createdAt_idx" ON "Notification"("recipientStaffId", "createdAt");
CREATE INDEX "Notification_patientId_idx" ON "Notification"("patientId");
