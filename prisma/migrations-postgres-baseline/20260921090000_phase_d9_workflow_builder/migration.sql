-- Phase D9 — workflow builder (PostgreSQL).
-- Mirrors prisma/migrations/20260921090000_phase_d9_workflow_builder.
--
-- Strictly additive: one new table holding the in-progress visual authoring
-- document (possibly-incomplete drafts). No DROP, no retype, no data change, no
-- enum. Status is TEXT (values enforced in code), per the D5–D8 convention.

-- CreateTable
CREATE TABLE "WorkflowBuilderDraft" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "facilityId" TEXT,
    "workflowDefinitionId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "document" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdByUserId" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkflowBuilderDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkflowBuilderDraft_organizationId_idx" ON "WorkflowBuilderDraft"("organizationId");
CREATE INDEX "WorkflowBuilderDraft_workflowDefinitionId_idx" ON "WorkflowBuilderDraft"("workflowDefinitionId");
CREATE INDEX "WorkflowBuilderDraft_organizationId_key_idx" ON "WorkflowBuilderDraft"("organizationId", "key");
