# Workflow Engine (Phase D7)

Aarogya has an **in-monolith workflow orchestration engine** built on the D6
transactional-event foundation. A committed domain event can trigger a versioned,
validated workflow that evaluates safe declarative conditions and drives durable
execution — tasks, timers, SLAs, escalations — through an allow-listed action
registry. It **orchestrates** existing domain services; it never owns canonical
clinical/financial state and never gains clinical authority.

```
DOMAIN MUTATION → DOMAIN EVENT (D6 outbox) → D6 DISPATCHER → WORKFLOW TRIGGER
  → VERSIONED WORKFLOW DEFINITION → CONDITION → WORKFLOW INSTANCE
  → STEP (CONDITION / ACTION / TASK / TIMER) → RETRY / SLA / ESCALATION
  → COMPLETION / FAILURE / CANCELLATION → AUDIT + DURABLE EXECUTION HISTORY
```

## What it is / isn't

| Is | Isn't |
|---|---|
| Durable orchestration in Next.js/Prisma (PostgreSQL-backed; SQLite for dev) | Microservices, Kafka/RabbitMQ/NATS/Temporal/Airflow, external workflow SaaS |
| Reuses the D6 outbox + dispatcher as the event boundary | A second event bus / event sourcing / CQRS |
| At-least-once execution with idempotent effects | Exactly-once execution |
| Bounded linear pipeline (acyclic; loop-capped) | A general graph / drag-and-drop builder |
| Safe declarative conditions + allow-listed actions | Arbitrary JS / SQL / server code |
| Tenant-isolated, C4-governed orchestration | A privilege-escalation or alternate-privileged API |

## Module map (`src/lib/workflows/`)

| File | Responsibility |
|---|---|
| `definition.ts` | Strict Zod schema for a workflow config (trigger, conditions, steps) |
| `conditions.ts` | Safe declarative condition grammar + in-memory evaluator |
| `actions.ts` | Allow-listed action registry |
| `validator.ts` | Publication-time validator (unknown trigger/action/operator, bounds) |
| `definitions.ts` | Definition + version management (create/version/publish/retire) |
| `engine.ts` | Event→workflow, instance runner, timer tick, retry, SLA escalation |
| `tasks.ts` | Orchestration `WorkflowTask` (idempotent create + guarded complete) |
| `timers.ts` | Durable timer storage helpers |
| `instances.ts` | Instance reads, cancellation, manual retry/recovery |
| `consumer.ts` / `register.ts` | The D6 `workflow-engine` consumer + its registration |
| `ops.ts` | Platform-only engine metrics |
| `authz.ts` | `workflow:*` authorization (reuses C4/D1) |
| `seed.ts` | Canonical global proof workflows |

## Verification

- Unit tests: `src/lib/workflows/workflows.test.ts` (vitest).
- Gate: `scripts/verify-postgres-d7-workflows.ts` (PostgreSQL: 48 checks incl. 7
  races; SQLite: 41, concurrency skipped by design).

See the sibling docs for detail: [architecture](architecture.md),
[definitions](definitions.md), [triggers](triggers.md), [conditions](conditions.md),
[actions](actions.md), [execution](execution.md), [retries](retries.md),
[timers](timers.md), [slas](slas.md), [security](security.md),
[operations](operations.md), [recovery](recovery.md).
