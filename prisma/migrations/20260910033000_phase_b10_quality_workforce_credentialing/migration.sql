-- CreateTable
CREATE TABLE "QualityIncident" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "patientId" TEXT,
    "encounterId" TEXT,
    "departmentId" TEXT,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'MODERATE',
    "confidentiality" TEXT NOT NULL DEFAULT 'STANDARD',
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "immediateAction" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REPORTED',
    "occurrenceAt" TIMESTAMP(3),
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "investigationStartedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "reopenedAt" TIMESTAMP(3),
    "reportedByStaffId" TEXT NOT NULL,
    "assignedInvestigatorStaffId" TEXT,
    "relatedEntityType" TEXT,
    "relatedEntityId" TEXT,
    "infectionIncidentId" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "QualityIncidentTransition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "toStatus" TEXT NOT NULL,
    "reason" TEXT,
    "actorStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QualityIncidentTransition_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "QualityIncident" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RootCauseAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "methodology" TEXT NOT NULL DEFAULT 'FIVE_WHYS',
    "problemStatement" TEXT NOT NULL,
    "contributingFactors" TEXT,
    "rootCauses" TEXT,
    "findings" TEXT,
    "recommendations" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "authoredByStaffId" TEXT NOT NULL,
    "reviewedByStaffId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RootCauseAnalysis_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "QualityIncident" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CapaAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "incidentId" TEXT,
    "findingId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "ownerStaffId" TEXT,
    "departmentId" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "evidenceDocumentId" TEXT,
    "completedAt" TIMESTAMP(3),
    "verifiedByStaffId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CapaAction_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "QualityIncident" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QualityStandard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "ownerStaffId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reviewDueAt" TIMESTAMP(3),
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "QualityMeasure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "standardId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "ownerStaffId" TEXT,
    "reviewedByStaffId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "QualityMeasure_standardId_fkey" FOREIGN KEY ("standardId") REFERENCES "QualityStandard" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ComplianceEvidence" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidenceType" TEXT,
    "documentId" TEXT,
    "incidentId" TEXT,
    "rcaId" TEXT,
    "capaId" TEXT,
    "standardId" TEXT,
    "measureId" TEXT,
    "findingId" TEXT,
    "auditId" TEXT,
    "providedByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComplianceEvidence_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "QualityIncident" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QualityAudit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scope" TEXT,
    "departmentId" TEXT,
    "auditorStaffId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PLANNED',
    "summary" TEXT,
    "plannedStartAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "QualityFinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "sourceType" TEXT,
    "auditId" TEXT,
    "standardId" TEXT,
    "measureId" TEXT,
    "incidentId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "identifiedByStaffId" TEXT NOT NULL,
    "closedByStaffId" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "QualityFinding_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "QualityAudit" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "QualityFinding_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "QualityIncident" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkforceAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "departmentId" TEXT,
    "operationalRole" TEXT,
    "assignmentType" TEXT NOT NULL DEFAULT 'PRIMARY',
    "supervisorStaffId" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "StaffAvailability" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "availability" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "reason" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "setByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "StaffShift" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "departmentId" TEXT,
    "shiftType" TEXT,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "supervisorStaffId" TEXT,
    "assignedByStaffId" TEXT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "StaffingRequirement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "departmentId" TEXT,
    "wardId" TEXT,
    "role" TEXT NOT NULL,
    "shiftType" TEXT,
    "minCount" INTEGER NOT NULL DEFAULT 1,
    "requiredCredentialType" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Credential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "credentialType" TEXT NOT NULL,
    "category" TEXT,
    "name" TEXT NOT NULL,
    "issuingAuthority" TEXT,
    "credentialNumber" TEXT,
    "issuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "verifiedByStaffId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "documentId" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "StaffPrivilege" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "facilityId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "privilegeType" TEXT NOT NULL,
    "scope" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "grantedByStaffId" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "suspendedAt" TIMESTAMP(3),
    "revokedByStaffId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "documentId" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateIndex
CREATE INDEX "QualityIncident_facilityId_status_idx" ON "QualityIncident"("facilityId", "status");

-- CreateIndex
CREATE INDEX "QualityIncident_facilityId_severity_idx" ON "QualityIncident"("facilityId", "severity");

-- CreateIndex
CREATE INDEX "QualityIncident_category_idx" ON "QualityIncident"("category");

-- CreateIndex
CREATE INDEX "QualityIncident_patientId_idx" ON "QualityIncident"("patientId");

-- CreateIndex
CREATE INDEX "QualityIncident_assignedInvestigatorStaffId_idx" ON "QualityIncident"("assignedInvestigatorStaffId");

-- CreateIndex
CREATE INDEX "QualityIncident_dueAt_idx" ON "QualityIncident"("dueAt");

-- CreateIndex
CREATE INDEX "QualityIncidentTransition_incidentId_idx" ON "QualityIncidentTransition"("incidentId");

-- CreateIndex
CREATE INDEX "QualityIncidentTransition_facilityId_idx" ON "QualityIncidentTransition"("facilityId");

-- CreateIndex
CREATE UNIQUE INDEX "RootCauseAnalysis_incidentId_key" ON "RootCauseAnalysis"("incidentId");

-- CreateIndex
CREATE INDEX "RootCauseAnalysis_facilityId_idx" ON "RootCauseAnalysis"("facilityId");

-- CreateIndex
CREATE INDEX "RootCauseAnalysis_status_idx" ON "RootCauseAnalysis"("status");

-- CreateIndex
CREATE INDEX "CapaAction_facilityId_status_idx" ON "CapaAction"("facilityId", "status");

-- CreateIndex
CREATE INDEX "CapaAction_incidentId_idx" ON "CapaAction"("incidentId");

-- CreateIndex
CREATE INDEX "CapaAction_dueAt_idx" ON "CapaAction"("dueAt");

-- CreateIndex
CREATE INDEX "CapaAction_ownerStaffId_idx" ON "CapaAction"("ownerStaffId");

-- CreateIndex
CREATE INDEX "QualityStandard_facilityId_status_idx" ON "QualityStandard"("facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "QualityStandard_facilityId_code_key" ON "QualityStandard"("facilityId", "code");

-- CreateIndex
CREATE INDEX "QualityMeasure_facilityId_status_idx" ON "QualityMeasure"("facilityId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "QualityMeasure_standardId_code_key" ON "QualityMeasure"("standardId", "code");

-- CreateIndex
CREATE INDEX "ComplianceEvidence_facilityId_idx" ON "ComplianceEvidence"("facilityId");

-- CreateIndex
CREATE INDEX "ComplianceEvidence_incidentId_idx" ON "ComplianceEvidence"("incidentId");

-- CreateIndex
CREATE INDEX "ComplianceEvidence_auditId_idx" ON "ComplianceEvidence"("auditId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceEvidence_measureId_documentId_key" ON "ComplianceEvidence"("measureId", "documentId");

-- CreateIndex
CREATE INDEX "QualityFinding_facilityId_status_idx" ON "QualityFinding"("facilityId", "status");

-- CreateIndex
CREATE INDEX "QualityFinding_auditId_idx" ON "QualityFinding"("auditId");

-- CreateIndex
CREATE INDEX "QualityFinding_incidentId_idx" ON "QualityFinding"("incidentId");

-- CreateIndex
CREATE INDEX "QualityAudit_facilityId_status_idx" ON "QualityAudit"("facilityId", "status");

-- CreateIndex
CREATE INDEX "WorkforceAssignment_facilityId_staffId_status_idx" ON "WorkforceAssignment"("facilityId", "staffId", "status");

-- CreateIndex
CREATE INDEX "WorkforceAssignment_facilityId_departmentId_idx" ON "WorkforceAssignment"("facilityId", "departmentId");

-- CreateIndex
CREATE INDEX "WorkforceAssignment_supervisorStaffId_idx" ON "WorkforceAssignment"("supervisorStaffId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffAvailability_staffId_key" ON "StaffAvailability"("staffId");

-- CreateIndex
CREATE INDEX "StaffAvailability_facilityId_availability_idx" ON "StaffAvailability"("facilityId", "availability");

-- CreateIndex
CREATE INDEX "StaffShift_facilityId_startAt_idx" ON "StaffShift"("facilityId", "startAt");

-- CreateIndex
CREATE INDEX "StaffShift_staffId_status_idx" ON "StaffShift"("staffId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StaffShift_staffId_startAt_key" ON "StaffShift"("staffId", "startAt");

-- CreateIndex
CREATE INDEX "StaffingRequirement_facilityId_status_idx" ON "StaffingRequirement"("facilityId", "status");

-- CreateIndex
CREATE INDEX "StaffingRequirement_facilityId_departmentId_idx" ON "StaffingRequirement"("facilityId", "departmentId");

-- CreateIndex
CREATE INDEX "Credential_facilityId_staffId_idx" ON "Credential"("facilityId", "staffId");

-- CreateIndex
CREATE INDEX "Credential_facilityId_status_idx" ON "Credential"("facilityId", "status");

-- CreateIndex
CREATE INDEX "Credential_expiresAt_idx" ON "Credential"("expiresAt");

-- CreateIndex
CREATE INDEX "Credential_credentialType_idx" ON "Credential"("credentialType");

-- CreateIndex
CREATE INDEX "StaffPrivilege_facilityId_staffId_status_idx" ON "StaffPrivilege"("facilityId", "staffId", "status");

-- CreateIndex
CREATE INDEX "StaffPrivilege_privilegeType_idx" ON "StaffPrivilege"("privilegeType");

-- CreateIndex
CREATE INDEX "StaffPrivilege_expiresAt_idx" ON "StaffPrivilege"("expiresAt");
