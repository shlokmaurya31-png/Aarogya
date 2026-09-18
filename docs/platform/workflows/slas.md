# SLAs & Escalation

The engine provides the **mechanism** for time-bound work; it does not hard-code
production business SLAs. Later the Configuration Engine (D8) can supply
hospital-specific durations.

## Definition

A `TASK` step may declare an SLA:

```json
{ "type": "TASK", "key": "review", "taskType": "REVIEW", "title": "Review critical result",
  "priority": "STAT",
  "sla": { "dueAfterSeconds": 900,
           "escalation": { "taskType": "ESCALATION", "title": "SLA breached", "priority": "STAT", "assignedRole": "HOSPITAL_ADMIN" } } }
```

## Deterministic deadlines

When the TASK step runs, the engine computes the deadline **once** —
`availableAt = now + dueAfterSeconds` — and stores it on a companion SLA
[timer](timers.md) (and on the task's `dueAt`). Deadlines are never recomputed from
mutable configuration, so a later definition change cannot retroactively move an
in-flight deadline.

## Breach → escalation

When the SLA timer fires:

- If the task is already `COMPLETED`/`CANCELLED` → **no escalation** (SLA met).
- Otherwise → create one escalation `WorkflowTask` (idempotent on `${timerId}:escalation`),
  optionally emitting a catalogued domain event.

Both branches are verified in the gate (breach → exactly one escalation; met → none;
concurrent ticks → one escalation).

## Not a clinical SLA store

Workflow SLAs are distinct from the existing clinical `SlaPolicy`/`hospital/sla.ts`
operational thresholds. The workflow engine does not read or write those; it carries
its own definition-driven durations.

> **Phase D8 update:** workflow SLA durations are now configurable per hospital/facility/department via the D8 configuration engine (`workflow.{key}.sla`), resolved at instance execution and snapshotted on the SLA timer for historical explainability. See `docs/platform/configuration/workflows.md`.
