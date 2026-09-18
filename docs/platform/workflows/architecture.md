# Workflow Engine — Architecture (Phase D7)

The D7 workflow engine is an **in-monolith orchestration layer** on top of the D6
transactional-event foundation. It reacts to committed domain events, evaluates safe
declarative conditions, and drives durable execution (tasks, timers, SLAs,
escalations) through an allow-listed action registry. It orchestrates existing
domain services; it never becomes a second clinical, billing, authorization, or
event system.

```
DOMAIN MUTATION → DOMAIN EVENT (D6 outbox) → D6 DISPATCHER → WORKFLOW CONSUMER
   → match published workflows → evaluate trigger condition → WorkflowInstance
   → steps (CONDITION / ACTION / TASK / TIMER) → SLA deadline → escalation
   → COMPLETED / FAILED / CANCELLED → AuditEvent + durable execution history
```

## Repository audit — reusable primitives & decisions

| Primitive | Found | D7 decision |
|---|---|---|
| D6 event catalogue (`src/lib/events/catalogue.ts`) | Yes — versioned `type@version` contracts | **Reuse** as the single source of truth for legal triggers; publication rejects unknown type/version. |
| D6 dispatcher + consumer registry (`src/lib/events/consumers.ts`, `dispatcher.ts`) | Yes — at-least-once + idempotent per-`(eventId,consumerName)` delivery | **Reuse**: register one `workflow-engine` consumer. No second event bus. |
| D6 emit (`emitDomainEvent(tx,…)`) | Yes | **Reuse** for the `EMIT_DOMAIN_EVENT` action, preserving causation. |
| Tenant context (`src/lib/auth/tenantContext.ts`) | Yes — `ActorMemberships`, `assertOrganizationAccess`, platform admin | **Reuse**; never trust client-supplied tenant. |
| C4 authorization / RBAC (`permissions.ts`, `requireActorMemberships`) | Yes | **Reuse**; add `workflow:*` permissions, no parallel RBAC. |
| AuditEvent (`src/lib/auth/audit.ts`) | Yes — optional tx client | **Reuse** for admin ops only (create/publish/retire/cancel/retry/recover). |
| Clinical `Task` model | Yes — but requires `facilityId` + `createdByStaffId` (a staff profile), coupled to Order/CarePlan | **Do NOT reuse for orchestration.** Workflow tasks are system-created, may be org-scoped (commercial), and must not gain clinical authority. A new **`WorkflowTask`** models orchestration to-dos. A future action provider can create genuine clinical `Task`s through the clinical service. |
| `SlaPolicy` / `hospital/sla.ts` | Yes — facility clinical-metric thresholds | **Do NOT couple.** Workflow SLAs are definition-driven durations; the deadline is computed once and stored on the step/task. Later Configuration Engine (D8) can supply per-hospital durations. |
| D6 `sensitiveGuard` | Yes | **Reuse** to keep PHI/secrets out of workflow config/context. |

### Conflicts / missing primitives

- No existing durable-timer primitive → introduce **`WorkflowTimer`** with a guarded
  lease/claim (mirrors the D6 dispatcher's claim idiom; correct without a daemon).
- No workflow definition/version/instance/step models → introduce them (below).
- No general orchestration task → `WorkflowTask` (above).

### Consumer registration seam

D6 consumers self-register at module load. The workflow consumer
(`src/lib/workflows/consumer.ts`) self-registers on import; the D6 dispatch route,
the workflow routes, and the gate import `@/lib/workflows/register` so the consumer
is present whenever dispatch runs. Dependency direction is **workflows → events**
only; the events layer never imports workflows.

## D7 boundaries (what it is / isn't)

- **Is:** durable, versioned, validated orchestration inside Next.js/Prisma; at-least-once
  execution with idempotent actions; guarded worker claims; bounded retry; durable
  timers; tenant-isolated; C4-governed.
- **Isn't:** microservices, Kafka/RabbitMQ/Temporal/Airflow, a separate workflow DB,
  distributed workers, event sourcing, CQRS, arbitrary code/SQL, a drag-and-drop
  builder, a clinical decision-maker, or a privilege-escalation path.

## Domain model (new, additive)

`WorkflowDefinition` (logical workflow, stable `key`, tenant scope) →
`WorkflowVersion` (immutable published JSON definition, DRAFT/PUBLISHED/RETIRED) →
`WorkflowInstance` (one execution, links `triggerEventId`/`correlationId`) →
`WorkflowStep` (CONDITION/ACTION/TASK/TIMER, guarded status) →
`WorkflowTask` (orchestration to-do) / `WorkflowTimer` (durable, leased).

## Clinical & financial safety boundary

A workflow action never gains clinical or financial authority by virtue of the
engine existing. Actions execute through existing domain services with their normal
C4/consent/tenant/invariant checks. The D7 action registry deliberately exposes only
safe orchestration actions (create/assign/complete orchestration tasks, timers,
workflow-state updates, and causally-linked domain-event emission). Emitting an event
does not perform the downstream clinical/financial mutation — that still runs behind
its own service and authorization.
