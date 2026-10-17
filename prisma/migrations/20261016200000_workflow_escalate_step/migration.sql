-- Batch 4, decision 1: a workflow step may ESCALATE an existing task (found by
-- its idempotency key) on SLA breach instead of creating one. Widens the step
-- type CHECK from 20261015140000_s8_platform; every existing value stays valid.
ALTER TABLE "WorkflowStep" DROP CONSTRAINT "WorkflowStep_stepType_check";
ALTER TABLE "WorkflowStep" ADD CONSTRAINT "WorkflowStep_stepType_check" CHECK ("stepType" IN ('CONDITION', 'ACTION', 'TASK', 'TIMER', 'ESCALATE'));
