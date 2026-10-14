-- Phase B9 Hospital Operations Layer. Additive; mirrors prisma/migrations/
-- 20260910021157_phase_b9_hospital_operations. Operational records around the
-- clinical core — all lifecycles are guarded String state machines (no new
-- enums), all links to canonical Patient/Encounter/Bed/Ward/Department/Staff are
-- plain FK strings validated server-side. Fully additive: only CREATE TABLE +
-- within-B9 FKs + indexes. No destructive change.

CREATE TABLE "HousekeepingRequest" (
    "id" TEXT NOT NULL,
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
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "inspectedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "notes" TEXT,
    "taskId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HousekeepingRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DietOrder" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "dietType" TEXT NOT NULL,
    "restrictions" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "orderedByStaffId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DietOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Meal" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "dietOrderId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "mealPeriod" TEXT NOT NULL,
    "plannedFor" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "preparedByStaffId" TEXT,
    "deliveredByStaffId" TEXT,
    "preparedAt" TIMESTAMP(3),
    "readyAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "refusedAt" TIMESTAMP(3),
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Meal_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PatientTransportRequest" (
    "id" TEXT NOT NULL,
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
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "assignedAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PatientTransportRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Ambulance" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "registration" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "capabilities" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Ambulance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AmbulanceTrip" (
    "id" TEXT NOT NULL,
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
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "arrivedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AmbulanceTrip_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MaintenanceRequest" (
    "id" TEXT NOT NULL,
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
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledReason" TEXT,
    "resolutionNote" TEXT,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MaintenanceRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PreventiveMaintenance" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "equipmentId" TEXT,
    "assetLabel" TEXT,
    "maintenanceType" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "performedAt" TIMESTAMP(3),
    "performedByStaffId" TEXT,
    "result" TEXT,
    "nextDueAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PreventiveMaintenance_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssetDowntime" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "equipmentId" TEXT,
    "assetLabel" TEXT,
    "locationLabel" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "byStaffId" TEXT NOT NULL,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AssetDowntime_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BiomedicalEquipment" (
    "id" TEXT NOT NULL,
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
    "warrantyUntil" TIMESTAMP(3),
    "nextServiceAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BiomedicalEquipment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BiomedicalCalibrationRecord" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "calibratedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performedByStaffId" TEXT NOT NULL,
    "result" TEXT,
    "certificateRef" TEXT,
    "nextDueAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BiomedicalCalibrationRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BiomedicalMaintenanceRecord" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "maintenanceType" TEXT NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "performedByStaffId" TEXT NOT NULL,
    "result" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BiomedicalMaintenanceRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EquipmentMovement" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "fromLocation" TEXT,
    "toLocation" TEXT,
    "reason" TEXT,
    "movedByStaffId" TEXT NOT NULL,
    "movedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EquipmentMovement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InfectionIncident" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT,
    "encounterId" TEXT,
    "wardId" TEXT,
    "locationLabel" TEXT,
    "incidentType" TEXT NOT NULL,
    "onsetAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'REPORTED',
    "isolationRequired" BOOLEAN NOT NULL DEFAULT false,
    "reportedByStaffId" TEXT NOT NULL,
    "reviewedByStaffId" TEXT,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InfectionIncident_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InfectionInvestigation" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "investigatorStaffId" TEXT NOT NULL,
    "findings" TEXT,
    "actionTaken" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "InfectionInvestigation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExposureRecord" (
    "id" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "affectedPersonRef" TEXT NOT NULL,
    "locationLabel" TEXT,
    "exposureAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DOCUMENTED',
    "reviewedByStaffId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExposureRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HousekeepingRequest_facilityId_status_idx" ON "HousekeepingRequest"("facilityId", "status");
CREATE INDEX "HousekeepingRequest_bedId_idx" ON "HousekeepingRequest"("bedId");
CREATE INDEX "HousekeepingRequest_assignedToStaffId_idx" ON "HousekeepingRequest"("assignedToStaffId");
CREATE INDEX "DietOrder_facilityId_status_idx" ON "DietOrder"("facilityId", "status");
CREATE INDEX "DietOrder_patientId_idx" ON "DietOrder"("patientId");
CREATE INDEX "DietOrder_encounterId_idx" ON "DietOrder"("encounterId");
CREATE INDEX "Meal_facilityId_status_idx" ON "Meal"("facilityId", "status");
CREATE INDEX "Meal_dietOrderId_idx" ON "Meal"("dietOrderId");
CREATE INDEX "Meal_patientId_idx" ON "Meal"("patientId");
CREATE INDEX "PatientTransportRequest_facilityId_status_idx" ON "PatientTransportRequest"("facilityId", "status");
CREATE INDEX "PatientTransportRequest_patientId_idx" ON "PatientTransportRequest"("patientId");
CREATE INDEX "PatientTransportRequest_assignedToStaffId_idx" ON "PatientTransportRequest"("assignedToStaffId");
CREATE INDEX "Ambulance_facilityId_status_idx" ON "Ambulance"("facilityId", "status");
CREATE UNIQUE INDEX "Ambulance_facilityId_registration_key" ON "Ambulance"("facilityId", "registration");
CREATE INDEX "AmbulanceTrip_facilityId_status_idx" ON "AmbulanceTrip"("facilityId", "status");
CREATE INDEX "AmbulanceTrip_ambulanceId_idx" ON "AmbulanceTrip"("ambulanceId");
CREATE INDEX "MaintenanceRequest_facilityId_status_idx" ON "MaintenanceRequest"("facilityId", "status");
CREATE INDEX "MaintenanceRequest_equipmentId_idx" ON "MaintenanceRequest"("equipmentId");
CREATE INDEX "MaintenanceRequest_assignedToStaffId_idx" ON "MaintenanceRequest"("assignedToStaffId");
CREATE INDEX "PreventiveMaintenance_facilityId_status_idx" ON "PreventiveMaintenance"("facilityId", "status");
CREATE INDEX "PreventiveMaintenance_equipmentId_idx" ON "PreventiveMaintenance"("equipmentId");
CREATE INDEX "AssetDowntime_facilityId_status_idx" ON "AssetDowntime"("facilityId", "status");
CREATE INDEX "AssetDowntime_equipmentId_idx" ON "AssetDowntime"("equipmentId");
CREATE INDEX "BiomedicalEquipment_facilityId_status_idx" ON "BiomedicalEquipment"("facilityId", "status");
CREATE UNIQUE INDEX "BiomedicalEquipment_facilityId_assetTag_key" ON "BiomedicalEquipment"("facilityId", "assetTag");
CREATE INDEX "BiomedicalCalibrationRecord_equipmentId_idx" ON "BiomedicalCalibrationRecord"("equipmentId");
CREATE INDEX "BiomedicalCalibrationRecord_facilityId_idx" ON "BiomedicalCalibrationRecord"("facilityId");
CREATE INDEX "BiomedicalMaintenanceRecord_equipmentId_idx" ON "BiomedicalMaintenanceRecord"("equipmentId");
CREATE INDEX "BiomedicalMaintenanceRecord_facilityId_idx" ON "BiomedicalMaintenanceRecord"("facilityId");
CREATE INDEX "EquipmentMovement_equipmentId_idx" ON "EquipmentMovement"("equipmentId");
CREATE INDEX "EquipmentMovement_facilityId_idx" ON "EquipmentMovement"("facilityId");
CREATE INDEX "InfectionIncident_facilityId_status_idx" ON "InfectionIncident"("facilityId", "status");
CREATE INDEX "InfectionIncident_incidentType_idx" ON "InfectionIncident"("incidentType");
CREATE INDEX "InfectionIncident_patientId_idx" ON "InfectionIncident"("patientId");
CREATE INDEX "InfectionInvestigation_incidentId_idx" ON "InfectionInvestigation"("incidentId");
CREATE INDEX "InfectionInvestigation_facilityId_idx" ON "InfectionInvestigation"("facilityId");
CREATE INDEX "ExposureRecord_incidentId_idx" ON "ExposureRecord"("incidentId");
CREATE INDEX "ExposureRecord_facilityId_idx" ON "ExposureRecord"("facilityId");

-- AddForeignKey
ALTER TABLE "Meal" ADD CONSTRAINT "Meal_dietOrderId_fkey" FOREIGN KEY ("dietOrderId") REFERENCES "DietOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AmbulanceTrip" ADD CONSTRAINT "AmbulanceTrip_ambulanceId_fkey" FOREIGN KEY ("ambulanceId") REFERENCES "Ambulance"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BiomedicalCalibrationRecord" ADD CONSTRAINT "BiomedicalCalibrationRecord_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "BiomedicalEquipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BiomedicalMaintenanceRecord" ADD CONSTRAINT "BiomedicalMaintenanceRecord_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "BiomedicalEquipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EquipmentMovement" ADD CONSTRAINT "EquipmentMovement_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "BiomedicalEquipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InfectionInvestigation" ADD CONSTRAINT "InfectionInvestigation_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "InfectionIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExposureRecord" ADD CONSTRAINT "ExposureRecord_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "InfectionIncident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
