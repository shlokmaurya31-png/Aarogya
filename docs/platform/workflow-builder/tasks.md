# Tasks

A TASK step configures a D7 `WorkflowTask` (an orchestration to-do, not a clinical
order). Fields: `taskType`, `title`, `description?`, `priority` (ROUTINE/URGENT/STAT),
`assignedRole?`, and an optional `sla` (see [slas](slas.md) / [escalations](escalations.md)).

Patient / encounter context is **derived from the triggering event** at execution
(D7 reads `payload.patientId` / `payload.encounterId`); the builder does not let an
author inject arbitrary patient IDs into a task (§11). Titles/descriptions are
length-bounded and secret/PHI-guarded — workflow definitions carry configuration,
never patient records.
