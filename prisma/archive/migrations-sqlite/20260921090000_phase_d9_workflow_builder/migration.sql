-- Phase D9 — workflow builder (SQLite).
-- Strictly additive: one new table holding the in-progress visual authoring
-- document (possibly-incomplete drafts), so D7's strict WorkflowVersion.config
-- store is never polluted with invalid definitions. No change to any existing
-- table. Status is TEXT (values enforced in code, per the D5–D8 convention).

-- CreateTable
CREATE TABLE "WorkflowBuilderDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT,
    "facilityId" TEXT,
    "workflowDefinitionId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "WorkflowBuilderDraft_organizationId_idx" ON "WorkflowBuilderDraft"("organizationId");
CREATE INDEX "WorkflowBuilderDraft_workflowDefinitionId_idx" ON "WorkflowBuilderDraft"("workflowDefinitionId");
CREATE INDEX "WorkflowBuilderDraft_organizationId_key_idx" ON "WorkflowBuilderDraft"("organizationId", "key");
