# Workflow & SLA Configuration (D7 integration)

D7 remains **canonical** for workflow execution. D8 provides configuration *around*
workflows; it does not duplicate `WorkflowDefinition`/`WorkflowVersion` or re-implement
timer execution.

## Keys

- `workflow.{key}.enabled` — enable/disable at a scope (foundation).
- `workflow.{key}.sla` — effective SLA (seconds) for the workflow's SLA step.
- `workflow.{key}.priority` — default task priority (foundation).
- `workflow.{key}.escalation` — declarative escalation policy (delivery is a later
  Notifications phase; D8 defines who/when/intent only — see [rules](rules.md)).

## SLA resolution + snapshot

When the D7 engine runs a TASK step that declares an SLA, it resolves
`workflow.{definitionKey}.sla` through the D8 resolver:

```
effective SLA = D8 override (DEPARTMENT→FACILITY→ORGANIZATION)
             ?? the workflow version's own sla.dueAfterSeconds   (SYSTEM fallback)
```

The resolved seconds **and its provenance** (`slaSource`, `slaVersion`) are
snapshotted onto the SLA `WorkflowTimer` payload. D7 still owns timer creation,
deadline persistence, breach detection, escalation, and the task lifecycle — D8 only
supplies the number.

Because the value is snapshotted at execution, a later configuration change never
retroactively moves an in-flight deadline (verified: an instance keeps its 15m SLA
after the org SLA is changed to 30m). This is the historical-explainability
guarantee.

## Safety

If a workflow key contains characters outside the registry slug, the engine falls
back to the version SLA rather than failing execution. Resolving configuration never
grants clinical authority — see [security](security.md).
