-- D6 (workflow spine §4): one Task model. WorkflowTask rows are copied into
-- Task with the same id; WorkflowTask itself is dropped by the next migration,
-- after verify-postgres-d7-workflows passes against this state.
--
-- Refuse, don't guess: every check below runs before anything changes, and
-- names the rows it refuses.

DO $$
DECLARE bad text;
BEGIN
  -- Task.source free text → TaskSource. A NULL source is mapped only when the
  -- row's own links say what created it (an order, or a care-plan intervention).
  SELECT string_agg(DISTINCT COALESCE(t."source", 'NULL') || ' (' || t."id" || ')', ', ') INTO bad FROM "Task" t
  WHERE COALESCE(t."source", '') NOT IN ('manual', 'care-plan', 'lab-order', 'imaging-order', 'event')
    AND NOT (t."source" IS NULL AND (t."orderId" IS NOT NULL OR EXISTS (SELECT 1 FROM "CarePlanIntervention" c WHERE c."taskId" = t."id")));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Task.source holds values with no TaskSource mapping: %; resolve before migrating', bad; END IF;

  -- OVERDUE stops being a status: it becomes OPEN, and the dueAt keeps it overdue.
  SELECT string_agg(t."id", ', ') INTO bad FROM "Task" t WHERE t."status" = 'OVERDUE' AND t."dueAt" IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Task rows are OVERDUE with no dueAt (cannot stay overdue once OVERDUE is derived): %; resolve before migrating', bad; END IF;

  -- WorkflowTask → Task.
  SELECT string_agg(w."id", ', ') INTO bad FROM "WorkflowTask" w WHERE w."facilityId" IS NULL AND w."organizationId" IS NULL;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'WorkflowTask rows have neither a facility nor an organization: %; resolve before migrating', bad; END IF;
  SELECT string_agg(w."id", ', ') INTO bad FROM "WorkflowTask" w
  WHERE w."facilityId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Facility" f WHERE f."id" = w."facilityId" AND (w."organizationId" IS NULL OR f."organizationId" = w."organizationId"));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'WorkflowTask rows name a facility that does not exist or is outside their organization: %; resolve before migrating', bad; END IF;
  SELECT string_agg(w."id", ', ') INTO bad FROM "WorkflowTask" w
  WHERE w."patientId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Patient" p WHERE p."id" = w."patientId" AND p."facilityId" = w."facilityId");
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'WorkflowTask rows name a patient that does not exist in their facility: %; resolve before migrating', bad; END IF;
  SELECT string_agg(w."id", ', ') INTO bad FROM "WorkflowTask" w
  WHERE w."encounterId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Encounter" e WHERE e."id" = w."encounterId" AND e."facilityId" = w."facilityId" AND (w."patientId" IS NULL OR e."patientId" = w."patientId"));
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'WorkflowTask rows name an encounter that does not exist in their facility (or belongs to another patient): %; resolve before migrating', bad; END IF;
  SELECT string_agg(w."id", ', ') INTO bad FROM "WorkflowTask" w WHERE EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = w."id");
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'WorkflowTask ids collide with Task ids: %; resolve before migrating', bad; END IF;
  SELECT string_agg(w."idempotencyKey", ', ') INTO bad FROM "WorkflowTask" w WHERE EXISTS (SELECT 1 FROM "Task" t WHERE t."idempotencyKey" = w."idempotencyKey");
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'WorkflowTask idempotency keys collide with Task keys: %; resolve before migrating', bad; END IF;
END $$;

-- TaskSource.
CREATE TYPE "TaskSource" AS ENUM ('MANUAL', 'CARE_PLAN', 'WORKFLOW', 'EVENT', 'ORDER');
ALTER TABLE "Task" RENAME COLUMN "source" TO "legacySource";
ALTER TABLE "Task" ADD COLUMN "source" "TaskSource";
UPDATE "Task" SET "source" = (CASE
  WHEN "legacySource" = 'manual' THEN 'MANUAL'
  WHEN "legacySource" = 'care-plan' THEN 'CARE_PLAN'
  WHEN "legacySource" IN ('lab-order', 'imaging-order') THEN 'ORDER'
  WHEN "legacySource" = 'event' THEN 'EVENT'
  WHEN "orderId" IS NOT NULL THEN 'ORDER'
  ELSE 'CARE_PLAN' -- only reachable for a NULL source linked from a care-plan intervention (checked above)
END)::"TaskSource";
ALTER TABLE "Task" ALTER COLUMN "source" SET NOT NULL;
ALTER TABLE "Task" DROP COLUMN "legacySource";

-- TaskStatus: OVERDUE → OPEN (derived from dueAt from now on); EXPIRED added.
UPDATE "Task" SET "status" = 'OPEN' WHERE "status" = 'OVERDUE';
CREATE TYPE "TaskStatus_new" AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'EXPIRED');
ALTER TABLE "Task" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Task" ALTER COLUMN "status" TYPE "TaskStatus_new" USING ("status"::text::"TaskStatus_new");
ALTER TYPE "TaskStatus" RENAME TO "TaskStatus_old";
ALTER TYPE "TaskStatus_new" RENAME TO "TaskStatus";
DROP TYPE "TaskStatus_old";
ALTER TABLE "Task" ALTER COLUMN "status" SET DEFAULT 'OPEN';

-- Workflow columns.
ALTER TABLE "Task" ADD COLUMN "organizationId" TEXT,
  ADD COLUMN "workflowInstanceId" TEXT,
  ADD COLUMN "workflowStepId" TEXT,
  ADD COLUMN "assignedRole" TEXT,
  ADD COLUMN "assignedUserId" TEXT,
  ADD COLUMN "completedByUserId" TEXT,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "facilityId" DROP NOT NULL;
ALTER TABLE "Task" ADD CONSTRAINT "Task_workflowInstanceId_fkey" FOREIGN KEY ("workflowInstanceId") REFERENCES "WorkflowInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- A task belongs to a facility, except an organization-level workflow task.
ALTER TABLE "Task" ADD CONSTRAINT "Task_facility_or_org_workflow_check"
  CHECK ("facilityId" IS NOT NULL OR ("source" = 'WORKFLOW' AND "organizationId" IS NOT NULL));
-- Workflow links only on workflow tasks, and every workflow task has its instance.
ALTER TABLE "Task" ADD CONSTRAINT "Task_workflow_links_check"
  CHECK (("source" = 'WORKFLOW') = ("workflowInstanceId" IS NOT NULL));
CREATE INDEX "Task_workflowInstanceId_idx" ON "Task"("workflowInstanceId");
CREATE INDEX "Task_organizationId_status_idx" ON "Task"("organizationId", "status");
CREATE INDEX "Task_status_dueAt_idx" ON "Task"("status", "dueAt");
-- Workflow keys are global (an organization-level task has no facility to scope them by).
CREATE UNIQUE INDEX "Task_workflow_idempotencyKey_key" ON "Task"("idempotencyKey") WHERE "source" = 'WORKFLOW';

-- Copy WorkflowTask → Task, same ids, status one-to-one.
INSERT INTO "Task" ("id", "facilityId", "organizationId", "title", "description", "type", "priority", "status", "dueAt", "source",
  "workflowInstanceId", "workflowStepId", "patientId", "encounterId", "assignedRole", "assignedUserId", "idempotencyKey",
  "completedByUserId", "completedAt", "cancelledAt", "createdAt", "updatedAt")
SELECT w."id", w."facilityId", w."organizationId", w."title", w."description", w."taskType", w."priority", w."status"::text::"TaskStatus", w."dueAt", 'WORKFLOW',
  w."workflowInstanceId", w."workflowStepId", w."patientId", w."encounterId", w."assignedRole", w."assignedUserId", w."idempotencyKey",
  w."completedByUserId", w."completedAt", w."cancelledAt", w."createdAt", w."updatedAt"
FROM "WorkflowTask" w;
