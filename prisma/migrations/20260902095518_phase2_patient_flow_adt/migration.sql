-- AlterTable
ALTER TABLE "Discharge" ADD COLUMN "expectedDischargeAt" DATETIME;
ALTER TABLE "Discharge" ADD COLUMN "expectedDischargeReason" TEXT;
ALTER TABLE "Discharge" ADD COLUMN "initiatedByStaffId" TEXT;

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "doctorStaffId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'NEW',
    "source" TEXT NOT NULL DEFAULT 'APPOINTMENT',
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "roomLabel" TEXT,
    "scheduledStart" DATETIME NOT NULL,
    "scheduledEnd" DATETIME NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "encounterId" TEXT,
    "cancelledReason" TEXT,
    "cancelledAt" DATETIME,
    "cancelledByStaffId" TEXT,
    "noShowAt" DATETIME,
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Appointment_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Appointment_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Appointment_doctorStaffId_fkey" FOREIGN KEY ("doctorStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Appointment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Appointment_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DoctorScheduleBlock" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "staffId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "type" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "specificDate" DATETIME,
    "startMinute" INTEGER,
    "endMinute" INTEGER,
    "slotDurationMinutes" INTEGER DEFAULT 15,
    "maxConcurrentAppointments" INTEGER NOT NULL DEFAULT 1,
    "roomLabel" TEXT,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DoctorScheduleBlock_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DoctorScheduleBlock_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DoctorScheduleBlock_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QueueEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "queueType" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT,
    "appointmentId" TEXT,
    "practitionerStaffId" TEXT,
    "priorityScore" INTEGER NOT NULL DEFAULT 100,
    "priorityReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "enteredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calledAt" DATETIME,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdByStaffId" TEXT,
    CONSTRAINT "QueueEntry_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "QueueEntry_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "QueueEntry_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "QueueEntry_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "QueueEntry_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "QueueEntry_practitionerStaffId_fkey" FOREIGN KEY ("practitionerStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TriageAssessment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "encounterId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "recordedByStaffId" TEXT NOT NULL,
    "acuity" INTEGER NOT NULL,
    "chiefComplaint" TEXT,
    "redFlags" TEXT,
    "assignedArea" TEXT,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TriageAssessment_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TriageAssessment_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TriageAssessment_recordedByStaffId_fkey" FOREIGN KEY ("recordedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EncounterLocation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "encounterId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "bedId" TEXT,
    "areaLabel" TEXT,
    "assignedByStaffId" TEXT,
    "assignedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" DATETIME,
    CONSTRAINT "EncounterLocation_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EncounterLocation_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "EncounterLocation_bedId_fkey" FOREIGN KEY ("bedId") REFERENCES "Bed" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AdmissionRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patientId" TEXT NOT NULL,
    "encounterId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "requestedByStaffId" TEXT NOT NULL,
    "requestedWardType" TEXT,
    "isolationRequired" BOOLEAN NOT NULL DEFAULT false,
    "genderRestriction" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "reason" TEXT NOT NULL,
    "expectedLosDays" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reviewedByStaffId" TEXT,
    "reviewedAt" DATETIME,
    "rejectionReason" TEXT,
    "reservedBedId" TEXT,
    "admissionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdmissionRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AdmissionRequest_encounterId_fkey" FOREIGN KEY ("encounterId") REFERENCES "Encounter" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AdmissionRequest_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AdmissionRequest_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AdmissionRequest_requestedByStaffId_fkey" FOREIGN KEY ("requestedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AdmissionRequest_reviewedByStaffId_fkey" FOREIGN KEY ("reviewedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AdmissionRequest_reservedBedId_fkey" FOREIGN KEY ("reservedBedId") REFERENCES "Bed" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "AdmissionRequest_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "Admission" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TransferRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "admissionId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "requestedByStaffId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "destinationWardType" TEXT,
    "isolationRequired" BOOLEAN NOT NULL DEFAULT false,
    "genderRestriction" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "transportRequired" BOOLEAN NOT NULL DEFAULT false,
    "clinicalHandoverRequired" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "acceptedByStaffId" TEXT,
    "reservedBedId" TEXT,
    "transferId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "TransferRequest_admissionId_fkey" FOREIGN KEY ("admissionId") REFERENCES "Admission" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TransferRequest_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TransferRequest_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TransferRequest_requestedByStaffId_fkey" FOREIGN KEY ("requestedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "TransferRequest_acceptedByStaffId_fkey" FOREIGN KEY ("acceptedByStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TransferRequest_reservedBedId_fkey" FOREIGN KEY ("reservedBedId") REFERENCES "Bed" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TransferRequest_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "Transfer" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SlaPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "thresholdMinutes" INTEGER NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SlaPolicy_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Encounter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "patientId" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "episodeOfCareId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REGISTERED',
    "chiefComplaint" TEXT,
    "triageLevel" INTEGER,
    "attendingStaffId" TEXT,
    "registeredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    "cancelledReason" TEXT,
    "accessSource" TEXT,
    "arrivalMode" TEXT,
    "traumaIndicator" BOOLEAN NOT NULL DEFAULT false,
    "ambulanceRef" TEXT,
    "accompanyingPerson" TEXT,
    "referringProviderName" TEXT,
    "referringFacilityName" TEXT,
    "referralUrgency" TEXT,
    CONSTRAINT "Encounter_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Encounter_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Encounter_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Encounter_episodeOfCareId_fkey" FOREIGN KEY ("episodeOfCareId") REFERENCES "EpisodeOfCare" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Encounter_attendingStaffId_fkey" FOREIGN KEY ("attendingStaffId") REFERENCES "HospitalStaffProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Encounter" ("attendingStaffId", "cancelledReason", "chiefComplaint", "closedAt", "departmentId", "episodeOfCareId", "facilityId", "id", "patientId", "registeredAt", "status", "triageLevel", "type") SELECT "attendingStaffId", "cancelledReason", "chiefComplaint", "closedAt", "departmentId", "episodeOfCareId", "facilityId", "id", "patientId", "registeredAt", "status", "triageLevel", "type" FROM "Encounter";
DROP TABLE "Encounter";
ALTER TABLE "new_Encounter" RENAME TO "Encounter";
CREATE INDEX "Encounter_facilityId_idx" ON "Encounter"("facilityId");
CREATE INDEX "Encounter_episodeOfCareId_idx" ON "Encounter"("episodeOfCareId");
CREATE INDEX "Encounter_status_idx" ON "Encounter"("status");
CREATE INDEX "Encounter_patientId_idx" ON "Encounter"("patientId");
CREATE TABLE "new_Patient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "uhid" TEXT NOT NULL,
    "facilityId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "preferredName" TEXT,
    "sex" TEXT NOT NULL,
    "dob" DATETIME,
    "dobPrecision" TEXT,
    "ageYears" INTEGER,
    "phone" TEXT,
    "address" TEXT,
    "language" TEXT DEFAULT 'en',
    "communicationPreference" TEXT,
    "bloodGroup" TEXT,
    "registrationStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "deceasedAt" DATETIME,
    "userId" TEXT,
    "mergedIntoId" TEXT,
    "mergedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Patient_facilityId_fkey" FOREIGN KEY ("facilityId") REFERENCES "Facility" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Patient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Patient_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Patient" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Patient" ("address", "ageYears", "bloodGroup", "communicationPreference", "createdAt", "deceasedAt", "dob", "dobPrecision", "facilityId", "fullName", "id", "language", "mergedAt", "mergedIntoId", "phone", "preferredName", "registrationStatus", "sex", "uhid", "updatedAt", "userId") SELECT "address", "ageYears", "bloodGroup", "communicationPreference", "createdAt", "deceasedAt", "dob", "dobPrecision", "facilityId", "fullName", "id", "language", "mergedAt", "mergedIntoId", "phone", "preferredName", "registrationStatus", "sex", "uhid", "updatedAt", "userId" FROM "Patient";
DROP TABLE "Patient";
ALTER TABLE "new_Patient" RENAME TO "Patient";
CREATE UNIQUE INDEX "Patient_uhid_key" ON "Patient"("uhid");
CREATE UNIQUE INDEX "Patient_userId_key" ON "Patient"("userId");
CREATE INDEX "Patient_facilityId_idx" ON "Patient"("facilityId");
CREATE INDEX "Patient_mergedIntoId_idx" ON "Patient"("mergedIntoId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Appointment_facilityId_idx" ON "Appointment"("facilityId");

-- CreateIndex
CREATE INDEX "Appointment_doctorStaffId_scheduledStart_idx" ON "Appointment"("doctorStaffId", "scheduledStart");

-- CreateIndex
CREATE INDEX "Appointment_status_idx" ON "Appointment"("status");

-- CreateIndex
CREATE INDEX "Appointment_patientId_idx" ON "Appointment"("patientId");

-- CreateIndex
CREATE INDEX "DoctorScheduleBlock_staffId_idx" ON "DoctorScheduleBlock"("staffId");

-- CreateIndex
CREATE INDEX "DoctorScheduleBlock_facilityId_idx" ON "DoctorScheduleBlock"("facilityId");

-- CreateIndex
CREATE INDEX "QueueEntry_facilityId_idx" ON "QueueEntry"("facilityId");

-- CreateIndex
CREATE INDEX "QueueEntry_queueType_idx" ON "QueueEntry"("queueType");

-- CreateIndex
CREATE INDEX "QueueEntry_status_idx" ON "QueueEntry"("status");

-- CreateIndex
CREATE INDEX "QueueEntry_patientId_idx" ON "QueueEntry"("patientId");

-- CreateIndex
CREATE INDEX "TriageAssessment_encounterId_idx" ON "TriageAssessment"("encounterId");

-- CreateIndex
CREATE INDEX "TriageAssessment_facilityId_idx" ON "TriageAssessment"("facilityId");

-- CreateIndex
CREATE INDEX "EncounterLocation_encounterId_idx" ON "EncounterLocation"("encounterId");

-- CreateIndex
CREATE INDEX "EncounterLocation_bedId_idx" ON "EncounterLocation"("bedId");

-- CreateIndex
CREATE UNIQUE INDEX "AdmissionRequest_admissionId_key" ON "AdmissionRequest"("admissionId");

-- CreateIndex
CREATE INDEX "AdmissionRequest_facilityId_idx" ON "AdmissionRequest"("facilityId");

-- CreateIndex
CREATE INDEX "AdmissionRequest_status_idx" ON "AdmissionRequest"("status");

-- CreateIndex
CREATE INDEX "AdmissionRequest_encounterId_idx" ON "AdmissionRequest"("encounterId");

-- CreateIndex
CREATE UNIQUE INDEX "TransferRequest_transferId_key" ON "TransferRequest"("transferId");

-- CreateIndex
CREATE INDEX "TransferRequest_facilityId_idx" ON "TransferRequest"("facilityId");

-- CreateIndex
CREATE INDEX "TransferRequest_status_idx" ON "TransferRequest"("status");

-- CreateIndex
CREATE INDEX "TransferRequest_admissionId_idx" ON "TransferRequest"("admissionId");

-- CreateIndex
CREATE UNIQUE INDEX "SlaPolicy_facilityId_metric_key" ON "SlaPolicy"("facilityId", "metric");
