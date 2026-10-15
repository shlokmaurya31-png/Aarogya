-- Workflow spine §2 (task-generator consumer): a task can be created by the
-- system in reaction to an event, with no staff creator, and is idempotent on
-- a key unique per facility (redelivery creates nothing new). Existing rows are
-- unchanged.
ALTER TABLE "Task" ALTER COLUMN "createdByStaffId" DROP NOT NULL;
ALTER TABLE "Task" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Task_facilityId_idempotencyKey_key" ON "Task"("facilityId", "idempotencyKey");
