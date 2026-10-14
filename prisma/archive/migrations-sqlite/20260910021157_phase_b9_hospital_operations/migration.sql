-- CreateTable
CREATE TABLE "HousekeepingRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "bedId" TEXT,
    "wardId" TEXT,
    "areaLabel" TEXT,
    "requestType" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "isDischargeCleaning" BOOLEAN NOT NULL DEFAULT false,
    "encounterId" TEXT,
    "requestedByStaffId" TEXT NOT NULL,
    "assignedToStaffId" TEXT,
    "inspectedByStaffId" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "inspectedAt" DATETIME,
    "closedAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelledReason" TEXT,
    "notes" TEXT,
    "taskId" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DietOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "dietType" TEXT NOT NULL,
    "restrictions" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "orderedByStaffId" TEXT NOT NULL,
    "effectiveFrom" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Meal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "dietOrderId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "mealPeriod" TEXT NOT NULL,
    "plannedFor" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "preparedByStaffId" TEXT,
    "deliveredByStaffId" TEXT,
    "preparedAt" DATETIME,
    "readyAt" DATETIME,
    "deliveredAt" DATETIME,
    "refusedAt" DATETIME,
    "notes" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Meal_dietOrderId_fkey" FOREIGN KEY ("dietOrderId") REFERENCES "DietOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PatientTransportRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "pickupBedId" TEXT,
    "pickupLabel" TEXT,
    "destinationBedId" TEXT,
    "destinationLabel" TEXT,
    "transportType" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "equipmentNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedByStaffId" TEXT NOT NULL,
    "assignedToStaffId" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" DATETIME,
    "assignedAt" DATETIME,
    "pickedUpAt" DATETIME,
    "arrivedAt" DATETIME,
    "completedAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelledReason" TEXT,
    "notes" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Ambulance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "registration" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "capabilities" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AmbulanceTrip" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "ambulanceId" TEXT,
    "patientId" TEXT,
    "encounterId" TEXT,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "crewNote" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedByStaffId" TEXT NOT NULL,
    "dispatchedByStaffId" TEXT,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" DATETIME,
    "arrivedAt" DATETIME,
    "completedAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelledReason" TEXT,
    "notes" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AmbulanceTrip_ambulanceId_fkey" FOREIGN KEY ("ambulanceId") REFERENCES "Ambulance" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MaintenanceRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "locationLabel" TEXT,
    "wardId" TEXT,
    "equipmentId" TEXT,
    "issueType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "status" TEXT NOT NULL DEFAULT 'REPORTED',
    "requestedByStaffId" TEXT NOT NULL,
    "assignedToStaffId" TEXT,
    "verifiedByStaffId" TEXT,
    "reportedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedAt" DATETIME,
    "startedAt" DATETIME,
    "resolvedAt" DATETIME,
    "verifiedAt" DATETIME,
    "closedAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelledReason" TEXT,
    "resolutionNote" TEXT,
    "notes" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PreventiveMaintenance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "equipmentId" TEXT,
    "assetLabel" TEXT,
    "maintenanceType" TEXT NOT NULL,
    "dueAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "performedAt" DATETIME,
    "performedByStaffId" TEXT,
    "result" TEXT,
    "nextDueAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AssetDowntime" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "equipmentId" TEXT,
    "assetLabel" TEXT,
    "locationLabel" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "byStaffId" TEXT NOT NULL,
    "notes" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BiomedicalEquipment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "assetTag" TEXT NOT NULL,
    "serialNumber" TEXT,
    "manufacturer" TEXT,
    "model" TEXT,
    "category" TEXT NOT NULL,
    "departmentId" TEXT,
    "locationLabel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IN_SERVICE',
    "calibrationStatus" TEXT,
    "warrantyUntil" DATETIME,
    "nextServiceAt" DATETIME,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BiomedicalCalibrationRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "calibratedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performedByStaffId" TEXT NOT NULL,
    "result" TEXT,
    "certificateRef" TEXT,
    "nextDueAt" DATETIME,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BiomedicalCalibrationRecord_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "BiomedicalEquipment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BiomedicalMaintenanceRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "maintenanceType" TEXT NOT NULL,
    "performedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performedByStaffId" TEXT NOT NULL,
    "result" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BiomedicalMaintenanceRecord_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "BiomedicalEquipment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EquipmentMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "fromLocation" TEXT,
    "toLocation" TEXT,
    "reason" TEXT,
    "movedByStaffId" TEXT NOT NULL,
    "movedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EquipmentMovement_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "BiomedicalEquipment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "InfectionIncident" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT,
    "encounterId" TEXT,
    "wardId" TEXT,
    "locationLabel" TEXT,
    "incidentType" TEXT NOT NULL,
    "onsetAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'REPORTED',
    "isolationRequired" BOOLEAN NOT NULL DEFAULT false,
    "reportedByStaffId" TEXT NOT NULL,
    "reviewedByStaffId" TEXT,
    "reportedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    "resolvedAt" DATETIME,
    "closedAt" DATETIME,
    "cancelledAt" DATETIME,
    "notes" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "InfectionInvestigation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "investigatorStaffId" TEXT NOT NULL,
    "findings" TEXT,
    "actionTaken" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "InfectionInvestigation_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "InfectionIncident" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ExposureRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "affectedPersonRef" TEXT NOT NULL,
    "locationLabel" TEXT,
    "exposureAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'DOCUMENTED',
    "reviewedByStaffId" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExposureRecord_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "InfectionIncident" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "HousekeepingRequest_facilityId_status_idx" ON "HousekeepingRequest"("facilityId", "status");

-- CreateIndex
CREATE INDEX "HousekeepingRequest_bedId_idx" ON "HousekeepingRequest"("bedId");

-- CreateIndex
CREATE INDEX "HousekeepingRequest_assignedToStaffId_idx" ON "HousekeepingRequest"("assignedToStaffId");

-- CreateIndex
CREATE INDEX "DietOrder_facilityId_status_idx" ON "DietOrder"("facilityId", "status");

-- CreateIndex
CREATE INDEX "DietOrder_patientId_idx" ON "DietOrder"("patientId");

-- CreateIndex
CREATE INDEX "DietOrder_encounterId_idx" ON "DietOrder"("encounterId");

-- CreateIndex
CREATE INDEX "Meal_facilityId_status_idx" ON "Meal"("facilityId", "status");

-- CreateIndex
CREATE INDEX "Meal_dietOrderId_idx" ON "Meal"("dietOrderId");

-- CreateIndex
CREATE INDEX "Meal_patientId_idx" ON "Meal"("patientId");

-- CreateIndex
CREATE INDEX "PatientTransportRequest_facilityId_status_idx" ON "PatientTransportRequest"("facilityId", "status");

-- CreateIndex
CREATE INDEX "PatientTransportRequest_patientId_idx" ON "PatientTransportRequest"("patientId");

-- CreateIndex
CREATE INDEX "PatientTransportRequest_assignedToStaffId_idx" ON "PatientTransportRequest"("assignedToStaffId");

-- CreateIndex
CREATE INDEX "Ambulance_facilityId_status_idx" ON "Ambulance"("facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Ambulance_facilityId_registration_key" ON "Ambulance"("facilityId", "registration");

-- CreateIndex
CREATE INDEX "AmbulanceTrip_facilityId_status_idx" ON "AmbulanceTrip"("facilityId", "status");

-- CreateIndex
CREATE INDEX "AmbulanceTrip_ambulanceId_idx" ON "AmbulanceTrip"("ambulanceId");

-- CreateIndex
CREATE INDEX "MaintenanceRequest_facilityId_status_idx" ON "MaintenanceRequest"("facilityId", "status");

-- CreateIndex
CREATE INDEX "MaintenanceRequest_equipmentId_idx" ON "MaintenanceRequest"("equipmentId");

-- CreateIndex
CREATE INDEX "MaintenanceRequest_assignedToStaffId_idx" ON "MaintenanceRequest"("assignedToStaffId");

-- CreateIndex
CREATE INDEX "PreventiveMaintenance_facilityId_status_idx" ON "PreventiveMaintenance"("facilityId", "status");

-- CreateIndex
CREATE INDEX "PreventiveMaintenance_equipmentId_idx" ON "PreventiveMaintenance"("equipmentId");

-- CreateIndex
CREATE INDEX "AssetDowntime_facilityId_status_idx" ON "AssetDowntime"("facilityId", "status");

-- CreateIndex
CREATE INDEX "AssetDowntime_equipmentId_idx" ON "AssetDowntime"("equipmentId");

-- CreateIndex
CREATE INDEX "BiomedicalEquipment_facilityId_status_idx" ON "BiomedicalEquipment"("facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BiomedicalEquipment_facilityId_assetTag_key" ON "BiomedicalEquipment"("facilityId", "assetTag");

-- CreateIndex
CREATE INDEX "BiomedicalCalibrationRecord_equipmentId_idx" ON "BiomedicalCalibrationRecord"("equipmentId");

-- CreateIndex
CREATE INDEX "BiomedicalCalibrationRecord_facilityId_idx" ON "BiomedicalCalibrationRecord"("facilityId");

-- CreateIndex
CREATE INDEX "BiomedicalMaintenanceRecord_equipmentId_idx" ON "BiomedicalMaintenanceRecord"("equipmentId");

-- CreateIndex
CREATE INDEX "BiomedicalMaintenanceRecord_facilityId_idx" ON "BiomedicalMaintenanceRecord"("facilityId");

-- CreateIndex
CREATE INDEX "EquipmentMovement_equipmentId_idx" ON "EquipmentMovement"("equipmentId");

-- CreateIndex
CREATE INDEX "EquipmentMovement_facilityId_idx" ON "EquipmentMovement"("facilityId");

-- CreateIndex
CREATE INDEX "InfectionIncident_facilityId_status_idx" ON "InfectionIncident"("facilityId", "status");

-- CreateIndex
CREATE INDEX "InfectionIncident_incidentType_idx" ON "InfectionIncident"("incidentType");

-- CreateIndex
CREATE INDEX "InfectionIncident_patientId_idx" ON "InfectionIncident"("patientId");

-- CreateIndex
CREATE INDEX "InfectionInvestigation_incidentId_idx" ON "InfectionInvestigation"("incidentId");

-- CreateIndex
CREATE INDEX "InfectionInvestigation_facilityId_idx" ON "InfectionInvestigation"("facilityId");

-- CreateIndex
CREATE INDEX "ExposureRecord_incidentId_idx" ON "ExposureRecord"("incidentId");

-- CreateIndex
CREATE INDEX "ExposureRecord_facilityId_idx" ON "ExposureRecord"("facilityId");
