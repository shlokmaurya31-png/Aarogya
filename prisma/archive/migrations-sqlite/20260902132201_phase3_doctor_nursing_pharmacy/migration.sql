-- AlterTable
ALTER TABLE "ClinicalNote" ADD COLUMN "amendedAt" DATETIME;
ALTER TABLE "ClinicalNote" ADD COLUMN "amendmentReason" TEXT;
ALTER TABLE "ClinicalNote" ADD COLUMN "authorRole" TEXT;

-- AlterTable
ALTER TABLE "Vital" ADD COLUMN "consciousness" TEXT;
ALTER TABLE "Vital" ADD COLUMN "o2DeliveryMethod" TEXT;
ALTER TABLE "Vital" ADD COLUMN "o2FlowRate" REAL;

-- CreateTable
CREATE TABLE "Order" (
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
    "labOrderId" TEXT,
    "imagingOrderId" TEXT,
    CONSTRAINT "Order_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_orderingStaffId_fkey" FOREIGN KEY ("orderingStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_labOrderId_fkey" FOREIGN KEY ("labOrderId") REFERENCES "LabOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Order_imagingOrderId_fkey" FOREIGN KEY ("imagingOrderId") REFERENCES "ImagingOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CarePlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "facilityId" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "targetDate" DATETIME,
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "notes" TEXT,
    CONSTRAINT "CarePlan_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CarePlan_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "CarePlan_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CarePlanIntervention" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "carePlanId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "responsibleRole" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "CarePlanIntervention_carePlanId_fkey" FOREIGN KEY ("carePlanId") REFERENCES "CarePlan" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClinicalHandoff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "type" TEXT NOT NULL,
    "fromStaffId" TEXT NOT NULL,
    "toStaffId" TEXT,
    "urgency" TEXT NOT NULL DEFAULT 'ROUTINE',
    "summary" TEXT NOT NULL,
    "activeProblems" TEXT,
    "pendingInvestigations" TEXT,
    "pendingMedications" TEXT,
    "pendingTasks" TEXT,
    "safetyConcerns" TEXT,
    "escalationRequired" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acknowledgedAt" DATETIME,
    "acknowledgedByStaffId" TEXT,
    CONSTRAINT "ClinicalHandoff_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ClinicalHandoff_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ClinicalHandoff_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ClinicalHandoff_fromStaffId_fkey" FOREIGN KEY ("fromStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ClinicalHandoff_toStaffId_fkey" FOREIGN KEY ("toStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NursingAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "nurseStaffId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "bedId" TEXT,
    "startAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endAt" DATETIME,
    "reason" TEXT,
    "assignedByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NursingAssignment_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "NursingAssignment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "NursingAssignment_nurseStaffId_fkey" FOREIGN KEY ("nurseStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "NursingAssignment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "NursingAssignment_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "NursingAssignment_bedId_fkey" FOREIGN KEY ("bedId") REFERENCES "Bed" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "VitalThreshold" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "minValue" REAL,
    "maxValue" REAL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "VitalThreshold_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IntakeOutputRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "encounterId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "ioType" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "quantityMl" REAL NOT NULL,
    "recordedByStaffId" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    CONSTRAINT "IntakeOutputRecord_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "IntakeOutputRecord_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MedicationSafetyWarning" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "medicationOrderId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "sourceId" TEXT,
    "acknowledgedByStaffId" TEXT,
    "acknowledgedAt" DATETIME,
    "overrideReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MedicationSafetyWarning_medicationOrderId_fkey" FOREIGN KEY ("medicationOrderId") REFERENCES "MedicationOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MedicationVerification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "medicationOrderId" TEXT NOT NULL,
    "pharmacistStaffId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MedicationVerification_medicationOrderId_fkey" FOREIGN KEY ("medicationOrderId") REFERENCES "MedicationOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MedicationVerification_pharmacistStaffId_fkey" FOREIGN KEY ("pharmacistStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DispensingRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "medicationOrderId" TEXT NOT NULL,
    "pharmacistStaffId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'FULL',
    "quantity" REAL NOT NULL,
    "quantityUnit" TEXT NOT NULL,
    "batchNumber" TEXT,
    "expiryDate" DATETIME,
    "substitutedDrugName" TEXT,
    "destination" TEXT,
    "witnessStaffId" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DispensingRecord_medicationOrderId_fkey" FOREIGN KEY ("medicationOrderId") REFERENCES "MedicationOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DispensingRecord_pharmacistStaffId_fkey" FOREIGN KEY ("pharmacistStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DispensingRecord_witnessStaffId_fkey" FOREIGN KEY ("witnessStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MedicationReconciliation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "medicationName" TEXT NOT NULL,
    "priorDose" TEXT,
    "decision" TEXT NOT NULL,
    "medicationOrderId" TEXT,
    "reason" TEXT,
    "reviewedByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MedicationReconciliation_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MedicationReconciliation_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MedicationReconciliation_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MedicationAdministration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "medicationOrderId" TEXT NOT NULL,
    "administeredByStaffId" TEXT,
    "scheduledAt" DATETIME NOT NULL,
    "administeredAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'DUE',
    "notes" TEXT,
    "reasonCode" TEXT,
    "witnessStaffId" TEXT,
    "safetyChecksConfirmed" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "MedicationAdministration_medicationOrderId_fkey" FOREIGN KEY ("medicationOrderId") REFERENCES "MedicationOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MedicationAdministration_administeredByStaffId_fkey" FOREIGN KEY ("administeredByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MedicationAdministration_witnessStaffId_fkey" FOREIGN KEY ("witnessStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_MedicationAdministration" ("administeredAt", "administeredByStaffId", "id", "medicationOrderId", "notes", "scheduledAt", "status") SELECT "administeredAt", "administeredByStaffId", "id", "medicationOrderId", "notes", "scheduledAt", "status" FROM "MedicationAdministration";
DROP TABLE "MedicationAdministration";
ALTER TABLE "new_MedicationAdministration" RENAME TO "MedicationAdministration";
CREATE INDEX "MedicationAdministration_medicationOrderId_idx" ON "MedicationAdministration"("medicationOrderId");
CREATE INDEX "MedicationAdministration_status_idx" ON "MedicationAdministration"("status");
CREATE TABLE "new_MedicationOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "encounterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "drugName" TEXT NOT NULL,
    "genericName" TEXT,
    "dose" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "durationDays" INTEGER,
    "orderedByStaffId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ORDERED',
    "safetyFlags" JSONB,
    "overrideReason" TEXT,
    "orderedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" TEXT,
    "formulation" TEXT,
    "strengthValue" REAL,
    "strengthUnit" TEXT,
    "doseValue" REAL,
    "doseUnit" TEXT,
    "timing" TEXT,
    "startAt" DATETIME,
    "stopAt" DATETIME,
    "prn" BOOLEAN NOT NULL DEFAULT false,
    "prnReason" TEXT,
    "specialInstructions" TEXT,
    "indication" TEXT,
    "isControlled" BOOLEAN NOT NULL DEFAULT false,
    "discontinuedAt" DATETIME,
    "discontinuedReason" TEXT,
    "discontinuedByStaffId" TEXT,
    "cancelledAt" DATETIME,
    "cancelledReason" TEXT,
    "cancelledByStaffId" TEXT,
    CONSTRAINT "MedicationOrder_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MedicationOrder_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MedicationOrder_orderedByStaffId_fkey" FOREIGN KEY ("orderedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MedicationOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_MedicationOrder" ("dose", "drugName", "durationDays", "encounterId", "frequency", "genericName", "id", "orderedAt", "orderedByStaffId", "overrideReason", "patientId", "route", "safetyFlags", "status") SELECT "dose", "drugName", "durationDays", "encounterId", "frequency", "genericName", "id", "orderedAt", "orderedByStaffId", "overrideReason", "patientId", "route", "safetyFlags", "status" FROM "MedicationOrder";
DROP TABLE "MedicationOrder";
ALTER TABLE "new_MedicationOrder" RENAME TO "MedicationOrder";
CREATE UNIQUE INDEX "MedicationOrder_orderId_key" ON "MedicationOrder"("orderId");
CREATE INDEX "MedicationOrder_encounterId_idx" ON "MedicationOrder"("encounterId");
CREATE INDEX "MedicationOrder_patientId_idx" ON "MedicationOrder"("patientId");
CREATE INDEX "MedicationOrder_status_idx" ON "MedicationOrder"("status");
CREATE TABLE "new_Referral" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "fromDepartmentId" TEXT,
    "toDepartmentId" TEXT,
    "fromStaffId" TEXT NOT NULL,
    "toStaffId" TEXT,
    "reason" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "status" TEXT NOT NULL DEFAULT 'PLACED',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" DATETIME,
    "acceptedAt" DATETIME,
    "orderId" TEXT,
    CONSTRAINT "Referral_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Referral_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Referral_fromDepartmentId_fkey" FOREIGN KEY ("fromDepartmentId") REFERENCES "Department" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Referral_toDepartmentId_fkey" FOREIGN KEY ("toDepartmentId") REFERENCES "Department" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Referral_fromStaffId_fkey" FOREIGN KEY ("fromStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Referral_toStaffId_fkey" FOREIGN KEY ("toStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Referral_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Referral" ("createdAt", "encounterId", "fromDepartmentId", "fromStaffId", "id", "notes", "patientId", "priority", "reason", "respondedAt", "status", "toDepartmentId", "toStaffId") SELECT "createdAt", "encounterId", "fromDepartmentId", "fromStaffId", "id", "notes", "patientId", "priority", "reason", "respondedAt", "status", "toDepartmentId", "toStaffId" FROM "Referral";
DROP TABLE "Referral";
ALTER TABLE "new_Referral" RENAME TO "Referral";
CREATE UNIQUE INDEX "Referral_orderId_key" ON "Referral"("orderId");
CREATE INDEX "Referral_patientId_idx" ON "Referral"("patientId");
CREATE INDEX "Referral_encounterId_idx" ON "Referral"("encounterId");
CREATE INDEX "Referral_status_idx" ON "Referral"("status");
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "dueAt" DATETIME,
    "source" TEXT,
    "patientId" TEXT,
    "encounterId" TEXT,
    "ownerStaffId" TEXT,
    "createdByStaffId" TEXT NOT NULL,
    "completedByStaffId" TEXT,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orderId" TEXT,
    "startedAt" DATETIME,
    "skippedAt" DATETIME,
    "skipReason" TEXT,
    "recurrenceRule" TEXT,
    CONSTRAINT "Task_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Task_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_ownerStaffId_fkey" FOREIGN KEY ("ownerStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Task_completedByStaffId_fkey" FOREIGN KEY ("completedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("completedAt", "completedByStaffId", "createdAt", "createdByStaffId", "departmentId", "description", "dueAt", "encounterId", "facilityId", "id", "ownerStaffId", "patientId", "priority", "source", "status", "title", "type") SELECT "completedAt", "completedByStaffId", "createdAt", "createdByStaffId", "departmentId", "description", "dueAt", "encounterId", "facilityId", "id", "ownerStaffId", "patientId", "priority", "source", "status", "title", "type" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_facilityId_idx" ON "Task"("facilityId");
CREATE INDEX "Task_status_idx" ON "Task"("status");
CREATE INDEX "Task_orderId_idx" ON "Task"("orderId");
CREATE INDEX "Task_ownerStaffId_idx" ON "Task"("ownerStaffId");
CREATE INDEX "Task_patientId_idx" ON "Task"("patientId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Order_facilityId_idx" ON "Order"("facilityId");

-- CreateIndex
CREATE INDEX "Order_encounterId_idx" ON "Order"("encounterId");

-- CreateIndex
CREATE INDEX "Order_patientId_idx" ON "Order"("patientId");

-- CreateIndex
CREATE INDEX "Order_status_idx" ON "Order"("status");

-- CreateIndex
CREATE INDEX "Order_orderType_idx" ON "Order"("orderType");

-- CreateIndex
CREATE INDEX "CarePlan_patientId_idx" ON "CarePlan"("patientId");

-- CreateIndex
CREATE INDEX "CarePlan_facilityId_idx" ON "CarePlan"("facilityId");

-- CreateIndex
CREATE INDEX "CarePlan_status_idx" ON "CarePlan"("status");

-- CreateIndex
CREATE INDEX "CarePlanIntervention_carePlanId_idx" ON "CarePlanIntervention"("carePlanId");

-- CreateIndex
CREATE INDEX "ClinicalHandoff_facilityId_idx" ON "ClinicalHandoff"("facilityId");

-- CreateIndex
CREATE INDEX "ClinicalHandoff_patientId_idx" ON "ClinicalHandoff"("patientId");

-- CreateIndex
CREATE INDEX "ClinicalHandoff_status_idx" ON "ClinicalHandoff"("status");

-- CreateIndex
CREATE INDEX "NursingAssignment_facilityId_idx" ON "NursingAssignment"("facilityId");

-- CreateIndex
CREATE INDEX "NursingAssignment_nurseStaffId_idx" ON "NursingAssignment"("nurseStaffId");

-- CreateIndex
CREATE INDEX "NursingAssignment_patientId_idx" ON "NursingAssignment"("patientId");

-- CreateIndex
CREATE UNIQUE INDEX "VitalThreshold_facilityId_metric_key" ON "VitalThreshold"("facilityId", "metric");

-- CreateIndex
CREATE INDEX "IntakeOutputRecord_encounterId_idx" ON "IntakeOutputRecord"("encounterId");

-- CreateIndex
CREATE INDEX "MedicationSafetyWarning_medicationOrderId_idx" ON "MedicationSafetyWarning"("medicationOrderId");

-- CreateIndex
CREATE INDEX "MedicationVerification_medicationOrderId_idx" ON "MedicationVerification"("medicationOrderId");

-- CreateIndex
CREATE INDEX "DispensingRecord_medicationOrderId_idx" ON "DispensingRecord"("medicationOrderId");

-- CreateIndex
CREATE INDEX "MedicationReconciliation_encounterId_idx" ON "MedicationReconciliation"("encounterId");

-- CreateIndex
CREATE INDEX "MedicationReconciliation_patientId_idx" ON "MedicationReconciliation"("patientId");
