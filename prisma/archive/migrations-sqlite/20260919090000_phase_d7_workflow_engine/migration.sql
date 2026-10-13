-- Phase D7 — workflow engine (SQLite).
-- Strictly additive: six new tables (definition, version, instance, step, task,
-- timer) with their indexes and foreign keys. No change to any existing table.
-- Status/category fields are TEXT; allowed values are enforced in code
-- (src/lib/workflows/), matching the D5/D6 convention.

-- CreateTable
CREATE TABLE "WorkflowDefinition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT,
    "facilityId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "triggerEventType" TEXT NOT NULL,
    "triggerEventVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "currentVersionId" TEXT,
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "WorkflowVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflowDefinitionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "config" JSONB NOT NULL,
    "publishedAt" DATETIME,
    "retiredAt" DATETIME,
    "createdByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkflowVersion_workflowDefinitionId_fkey" FOREIGN KEY ("workflowDefinitionId") REFERENCES "WorkflowDefinition" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowInstance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflowDefinitionId" TEXT NOT NULL,
    "workflowVersionId" TEXT NOT NULL,
    "triggerEventId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "organizationId" TEXT,
    "facilityId" TEXT,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNABLE',
    "correlationId" TEXT NOT NULL,
    "causationId" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "claimToken" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "failureCategory" TEXT,
    "failureMessage" TEXT,
    "cancelledByUserId" TEXT,
    "cancelReason" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "cancelledAt" DATETIME,
    "failedAt" DATETIME,
    "lastAttemptAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkflowInstance_workflowDefinitionId_fkey" FOREIGN KEY ("workflowDefinitionId") REFERENCES "WorkflowDefinition" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WorkflowInstance_workflowVersionId_fkey" FOREIGN KEY ("workflowVersionId") REFERENCES "WorkflowVersion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflowInstanceId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "stepType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "availableAt" DATETIME,
    "claimToken" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "failureCategory" TEXT,
    "failureMessage" TEXT,
    "resultRef" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkflowStep_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflowInstanceId" TEXT NOT NULL,
    "workflowStepId" TEXT,
    "organizationId" TEXT,
    "facilityId" TEXT,
    "patientId" TEXT,
    "encounterId" TEXT,
    "taskType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'ROUTINE',
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "assignedRole" TEXT,
    "assignedUserId" TEXT,
    "dueAt" DATETIME,
    "completedByUserId" TEXT,
    "completedAt" DATETIME,
    "cancelledAt" DATETIME,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkflowTask_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkflowTimer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workflowInstanceId" TEXT NOT NULL,
    "workflowStepId" TEXT,
    "kind" TEXT NOT NULL,
    "availableAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "claimToken" TEXT,
    "claimedAt" DATETIME,
    "completedAt" DATETIME,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkflowTimer_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowDefinition_organizationId_key_key" ON "WorkflowDefinition"("organizationId", "key");
CREATE INDEX "WorkflowDefinition_triggerEventType_status_idx" ON "WorkflowDefinition"("triggerEventType", "status");
CREATE INDEX "WorkflowDefinition_organizationId_idx" ON "WorkflowDefinition"("organizationId");
CREATE INDEX "WorkflowDefinition_status_idx" ON "WorkflowDefinition"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_workflowDefinitionId_version_key" ON "WorkflowVersion"("workflowDefinitionId", "version");
CREATE INDEX "WorkflowVersion_status_idx" ON "WorkflowVersion"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowInstance_idempotencyKey_key" ON "WorkflowInstance"("idempotencyKey");
CREATE INDEX "WorkflowInstance_status_idx" ON "WorkflowInstance"("status");
CREATE INDEX "WorkflowInstance_organizationId_idx" ON "WorkflowInstance"("organizationId");
CREATE INDEX "WorkflowInstance_triggerEventId_idx" ON "WorkflowInstance"("triggerEventId");
CREATE INDEX "WorkflowInstance_correlationId_idx" ON "WorkflowInstance"("correlationId");
CREATE INDEX "WorkflowInstance_workflowDefinitionId_idx" ON "WorkflowInstance"("workflowDefinitionId");
CREATE INDEX "WorkflowInstance_aggregateType_aggregateId_idx" ON "WorkflowInstance"("aggregateType", "aggregateId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowStep_workflowInstanceId_stepIndex_key" ON "WorkflowStep"("workflowInstanceId", "stepIndex");
CREATE INDEX "WorkflowStep_workflowInstanceId_status_idx" ON "WorkflowStep"("workflowInstanceId", "status");
CREATE INDEX "WorkflowStep_status_availableAt_idx" ON "WorkflowStep"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTask_idempotencyKey_key" ON "WorkflowTask"("idempotencyKey");
CREATE INDEX "WorkflowTask_organizationId_status_idx" ON "WorkflowTask"("organizationId", "status");
CREATE INDEX "WorkflowTask_status_dueAt_idx" ON "WorkflowTask"("status", "dueAt");
CREATE INDEX "WorkflowTask_workflowInstanceId_idx" ON "WorkflowTask"("workflowInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowTimer_idempotencyKey_key" ON "WorkflowTimer"("idempotencyKey");
CREATE INDEX "WorkflowTimer_status_availableAt_idx" ON "WorkflowTimer"("status", "availableAt");
CREATE INDEX "WorkflowTimer_workflowInstanceId_idx" ON "WorkflowTimer"("workflowInstanceId");
