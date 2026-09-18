# Workflow Definitions & Versioning

A workflow definition (`WorkflowDefinition`) is a logical workflow with a stable
machine `key` (never a display name), an optional tenant scope, and a denormalized
trigger (event type@version) used for indexed matching. Its executable payload lives
in **immutable versions** (`WorkflowVersion`).

## Versioning rules

- Every version has an explicit integer `version` and a status: `DRAFT` →
  `PUBLISHED` → `RETIRED`.
- A published version is **never mutated in place**. A change creates a new DRAFT
  version; publishing it retires the previously published one.
- A definition has **at most one PUBLISHED version** at a time
  (`WorkflowDefinition.currentVersionId`), enforced by a guarded, race-safe
  transition (see [operations](operations.md); Race 6 in the gate).
- Historical instances keep referencing the exact version that created them
  (`WorkflowInstance.workflowVersionId`), so replays/inspection are faithful.

## Tenant scope

- `organizationId = null` → a **global** platform template (matches events from any
  organization).
- `organizationId = <org>` → an **org-scoped** definition, readable only by that org
  (or the platform). Key uniqueness is per scope (`@@unique([organizationId, key])`).

## Storage & validation

The version `config` is stored as JSON, validated by a strict Zod schema
(`WorkflowConfigSchema`) and the publication-time validator **before** it can be
published. An invalid definition never reaches execution. See
[conditions](conditions.md) and [actions](actions.md) for the grammar, and the
[security](security.md) doc for the bounds (max steps/nodes/nesting/durations).

## Authoring authority

Create / version / publish / retire are **platform-only** (`workflow:manage`). Org
and hospital admins have `workflow:read` for their own scope and cannot author,
publish, or operate workflows.
