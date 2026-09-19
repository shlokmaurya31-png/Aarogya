# Authoring

The builder workspace (`/hospital-os/enterprise/workflows`) has three regions plus a
top bar: a **palette** (add Trigger/Condition/Task/Timer/Action, load templates and
drafts), a **pipeline canvas** (the vertical WHEN → IF → THEN flow of node cards,
with select / reorder / delete), and a **properties + validation + simulation** panel.

## The builder document

Authoring edits a builder document — a lenient superset of the canonical D7 config:

```json
{ "name": "ICU admission", "trigger": { "eventType": "AdmissionCreated", "eventVersion": 1 },
  "steps": [ { "type": "TASK", "key": "nursing", "taskType": "NURSING_ASSESSMENT", "title": "Nursing assessment", "priority": "URGENT", "assignedRole": "NURSE" } ],
  "layout": { "nursing": { "x": 0, "y": 1 } } }
```

`trigger`/`steps` are the canonical shapes; `layout` is builder-only and dropped on
compile. There is no separate execution format (§3).

## Lifecycle

`Save draft` → `Validate` (live, advisory) → `Simulate` (safe) → `Publish`. Drafts may
be incomplete; only a document that compiles + passes the D7 validator can publish.
See [validation](validation.md), [simulation](simulation.md), [versioning](versioning.md).

## Accessibility (§44)

The pipeline is a structured, keyboard-operable node list with labelled controls
(add / move up / move down / delete / select) and a properties form — the canvas is
never the only way to author. Validation state is shown with text + icon (not
color-only).
