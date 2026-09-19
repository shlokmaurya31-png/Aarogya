# Workflow Builder — Architecture (Phase D9)

D9 is the **authoring layer** that lets authorized hospital administrators visually
create, validate, version, configure, simulate, publish, and retire workflows
**without writing code**. It is **not** a new workflow engine, condition engine,
event system, or configuration engine — it produces the *same canonical D7 workflow
definition* that D7 executes and D8 governs.

```
D6 EVENT ARCHITECTURE → D7 WORKFLOW ENGINE → D8 CONFIGURATION ENGINE → D9 BUILDER
  admin authors → builder document → compile → canonical D7 config → D7 validator
  → D7 definition + version (DRAFT) → D8-governed publish → D7 execution
```

**Responsibility rule:** D9 creates workflows, D8 governs them, D7 executes them,
D6 says what happened. D9 never blurs those lines.

## Repository audit — reuse vs new

| Capability | Source | D9 decision |
|---|---|---|
| Event catalogue (legal triggers) | D6 `EVENT_CONTRACTS` / `getEventContract` / `currentVersion` | **Reuse** — trigger picker is generated from it; unknown events cannot publish. |
| Canonical workflow config + validator | D7 `WorkflowConfigSchema` / `validateWorkflowConfig` | **Reuse** — the builder compiles to this exact shape; the D7 validator is authoritative. |
| Condition grammar + evaluator | D7 `ConditionSchema` / `evaluateCondition` | **Reuse** — no second expression language; the builder emits canonical condition JSON. |
| Action registry | D7 `ACTION_REGISTRY` / `isInvokableFromDefinition` | **Reuse** — only real, permitted actions are offered. |
| Definition/version lifecycle | D7 `createDefinition` / `createVersion` / `publishVersion` / `retireDefinition` | **Reuse** — publishing a builder draft calls these; no duplicate version system. |
| SLA / effective config | D8 `resolveConfig` / `resolveEffectiveInternal` | **Reuse** — SLA provenance is shown; execution snapshots it (D8/D7). |
| Tenant context + C4 | D1 / C4 | **Reuse** — authoring is tenant-scoped (see authz change below). |
| AuditEvent + `sensitiveGuard` | existing | **Reuse** — builder acts are audited; PHI/secrets are rejected. |

### One authz change to D7 (documented)

D7 originally made authoring **platform-only**. D9 needs hospital administrators to
build workflows for their own organization, so D7's authoring authorization is
relaxed to `assertCanAuthorWorkflow(m, organizationId)`: a **global** template
(organizationId null) stays platform-only; an **org-scoped** workflow requires org
administration (or platform). The D7 gate's authoring-denial tests operate on global
templates and remain green. Execution and D8 governance are unchanged.

## D9 domain model (one additive table)

The only durable builder-specific state is `WorkflowBuilderDraft`: the in-progress,
possibly-incomplete builder document (a superset of the canonical config plus
canvas/layout metadata), tenant-scoped, optionally linked to an existing D7
definition when editing. This satisfies "save incomplete drafts" (§19) **without**
polluting D7's strict version store — D7's `WorkflowVersion.config` must always be
valid, so invalid drafts live here until they compile. Publishing compiles the draft
→ canonical config → D7 `createDefinition`/`createVersion` → `publishVersion`
(atomic). No `WorkflowDefinition`/`WorkflowVersion`/`WorkflowInstance`/`WorkflowStep`
is duplicated.

## Backend (`src/lib/workflow-builder/`)

| File | Responsibility |
|---|---|
| `document.ts` | Lenient builder-document Zod schema + bounds (nodes/depth/size) |
| `compile.ts` | Compile a builder document → canonical D7 `WorkflowConfig` (then D7 validator) |
| `validate.ts` | Structured validation report (trigger/conditions/actions/sla/scope/security/deps) |
| `simulate.ts` | Side-effect-free simulation (trigger match + condition eval + would-run steps + D8 SLA) |
| `templates.ts` | A few safe starter templates (copied into drafts, never auto-published) |
| `diff.ts` | Semantic version diff |
| `metadata.ts` | Builder metadata (D6 events + D7 actions/operators + limits) from canonical sources |
| `drafts.ts` | Draft CRUD + `publishDraft` (compile → D7 lifecycle) + import/export, tenant-scoped |
| `index.ts` | Public surface |

## Safety posture

At-least-once/execution semantics are D7's; D9 adds no execution. Simulation is
strictly side-effect free (no tasks/timers/events/records). All limits are enforced
server-side (UI validation is advisory). Tenant scope is server-derived; C4 stays
authoritative; the builder can never grant permissions or invoke a clinical/financial
mutation. PHI/secrets are rejected via `sensitiveGuard`. Imports enter DRAFT only and
are fully revalidated; cross-tenant references are rejected.
