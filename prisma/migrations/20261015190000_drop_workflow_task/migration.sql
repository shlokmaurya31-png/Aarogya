-- D6 (workflow spine §4), second half: drop WorkflowTask. Applied only after
-- verify-postgres-d7-workflows passed against the merged Task (previous
-- migration). Refuses if any WorkflowTask row is not reachable as a Task with
-- the same id — for example, one written by old code between the two migrations.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(w."id", ', ') INTO bad FROM "WorkflowTask" w
  WHERE NOT EXISTS (SELECT 1 FROM "Task" t WHERE t."id" = w."id" AND t."source" = 'WORKFLOW' AND t."workflowInstanceId" = w."workflowInstanceId");
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'WorkflowTask rows are not reachable as a matching Task: %; re-run the copy before dropping', bad; END IF;
END $$;

DROP TABLE "WorkflowTask";
DROP TYPE "WorkflowTaskStatus";
