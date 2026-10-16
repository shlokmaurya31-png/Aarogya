-- Batch 4, decision 5: a workflow timer that keeps failing (or fails
-- permanently) is FAILED after a bounded number of attempts instead of being
-- released forever. Additive: every existing value stays valid.
ALTER TYPE "WorkflowTimerStatus" ADD VALUE IF NOT EXISTS 'FAILED';
