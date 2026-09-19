# Workflow Builder (Phase D9)

The Workflow Builder lets an authorized hospital administrator **create workflows
without writing code** — a visual authoring layer over the D7 workflow engine,
governed by D8 configuration and driven by D6 events.

```
D6 EVENTS → D7 ENGINE → D8 CONFIG → D9 BUILDER
  admin authors (palette + pipeline + properties) → builder document
  → compile → canonical D7 config → D7 validator → D7 definition + version
  → publish → D7 execution (with D8-configured, snapshotted SLAs)
```

**Responsibility rule:** D9 creates workflows, D8 governs them, D7 executes them,
D6 tells the system what happened.

## What it is / isn't

| Is | Isn't |
|---|---|
| A visual authoring UI producing the canonical D7 definition | A new/second workflow or condition engine |
| Reuses D6 catalogue, D7 validator/actions/conditions, D8 resolver | A rules language / arbitrary code / SQL / eval |
| Draft → validate → publish → version, with simulation | A BPMN platform / drag-drop everything / marketplace |
| Tenant-scoped, C4-governed, audited | A permission or authorization editor |
| Side-effect-free simulation | A production event-replay tool |

## Module map (`src/lib/workflow-builder/`)

| File | Responsibility |
|---|---|
| `document.ts` | Lenient builder-document schema + safety bounds + secret/PHI guard |
| `compile.ts` | Compile → canonical D7 config; structured validation report; semantic diff |
| `simulate.ts` | Side-effect-free simulation (trigger/condition/would-run steps + D8 SLA) |
| `templates.ts` | Safe starter templates (copied into drafts, never auto-published) |
| `metadata.ts` | Builder metadata from D6 catalogue + D7 registry/operators/limits |
| `drafts.ts` | Draft CRUD, publish (→ D7 lifecycle), import/export |

The only new table is `WorkflowBuilderDraft` (holds incomplete drafts so D7's strict
version store is never polluted). Publishing drives D7's `createDefinition` /
`createVersion` / `publishVersion`.

## Verification

- Unit tests: `src/lib/workflow-builder/workflow-builder.test.ts` (vitest).
- Gate: `scripts/verify-postgres-d9-builder.ts` (PostgreSQL: 31 checks incl. 7 races
  + E2E build→publish→execute + multi-hospital SLA; SQLite: 25, concurrency skipped).

See: [architecture](architecture.md), [authoring](authoring.md),
[triggers](triggers.md), [conditions](conditions.md), [actions](actions.md),
[tasks](tasks.md), [slas](slas.md), [escalations](escalations.md),
[validation](validation.md), [simulation](simulation.md), [versioning](versioning.md),
[security](security.md), [operations](operations.md).
