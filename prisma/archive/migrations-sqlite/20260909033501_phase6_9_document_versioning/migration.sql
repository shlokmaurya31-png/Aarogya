-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ClinicalDocument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "storageRef" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'CURRENT',
    "accessPolicy" TEXT NOT NULL DEFAULT 'CLINICAL_STAFF',
    "authorStaffId" TEXT,
    "uploadedByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClinicalDocument_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ClinicalDocument_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ClinicalDocument_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClinicalDocument_authorStaffId_fkey" FOREIGN KEY ("authorStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClinicalDocument_uploadedByStaffId_fkey" FOREIGN KEY ("uploadedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ClinicalDocument" ("accessPolicy", "authorStaffId", "createdAt", "encounterId", "facilityId", "id", "patientId", "storageRef", "title", "type", "uploadedByStaffId", "version") SELECT "accessPolicy", "authorStaffId", "createdAt", "encounterId", "facilityId", "id", "patientId", "storageRef", "title", "type", "uploadedByStaffId", "version" FROM "ClinicalDocument";
DROP TABLE "ClinicalDocument";
ALTER TABLE "new_ClinicalDocument" RENAME TO "ClinicalDocument";
CREATE INDEX "ClinicalDocument_patientId_idx" ON "ClinicalDocument"("patientId");
CREATE INDEX "ClinicalDocument_facilityId_idx" ON "ClinicalDocument"("facilityId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
