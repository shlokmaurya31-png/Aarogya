# Escalations

An SLA's `escalation` is a declarative policy: on breach, D7 creates an escalation
`WorkflowTask` (taskType/title/priority/assignedRole) and may emit a catalogued
domain event. The builder configures **who / when / what intent / priority**.

D9 does **not** implement notification delivery (SMS/email/push) — that is a later
platform capability. The escalation configuration is persisted in the D7/D8-compatible
schema so a future Notifications layer can consume it as an action provider without
rewriting workflows (§13).
