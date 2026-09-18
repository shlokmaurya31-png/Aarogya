# Operations

Platform operators drive and observe the engine through a small API surface and a
self-hiding Workflow Operations panel. There is **no** generic
`POST /workflows/execute` — clients cannot arbitrarily execute an action.

## API surface

| Route | Perm | Purpose |
|---|---|---|
| `GET /api/hospital/enterprise/workflows` | `workflow:read` | List definitions (scoped) |
| `POST /api/hospital/enterprise/workflows` | `workflow:manage` | Create definition |
| `GET /api/hospital/enterprise/workflows/[id]` | `workflow:read` | Definition + versions |
| `POST …/workflows/[id]/versions` | `workflow:manage` | Create a DRAFT version |
| `POST …/workflows/[id]/publish` | `workflow:manage` | Publish a version (race-safe) |
| `POST …/workflows/[id]/retire` | `workflow:manage` | Retire the definition |
| `GET /api/hospital/enterprise/workflow-instances` | `workflow:read` | List instances (scoped) |
| `GET …/workflow-instances/[id]` | `workflow:read` | Instance + steps/tasks/timers |
| `POST …/workflow-instances/[id]/cancel` | `workflow:operate` | Cancel (audited) |
| `POST …/workflow-instances/[id]/retry` | `workflow:operate` | Manual retry/recovery |
| `GET /api/hospital/enterprise/workflow-ops/metrics` | `workflow:operate` | Engine metrics |
| `POST /api/hospital/enterprise/workflow-ops/tick` | `workflow:operate` | Bounded engine tick |

## Metrics

`getWorkflowMetrics` reports **engine** metrics (not business KPIs): instances by
status, tasks by status, timers by status, active definitions, overdue tasks, due /
pending timers, failed instances, average latency, and a derived health signal
(`HEALTHY` / `ATTENTION` / `CRITICAL`). D6 events remain the analytics boundary.

## Tick / scheduling

`tickWorkflows` (via the `tick` route) fires due timers and advances runnable
instances, bounded by `batchSize` and a max duration. D7 ships **no** automated
scheduler; a cron/worker/operator invokes the tick. Because state is durable and
claims are guarded, running the tick more or less often only changes latency, never
correctness.

## Audit

Administrative operations are audited (who did what): `workflow.definition.created`,
`workflow.version.created`, `workflow.published`, `workflow.retired`,
`workflow.instance.cancelled`, `workflow.instance.retried`,
`workflow.instance.recovered`. Normal execution progress is **not** mirrored to
audit — it lives in the durable `WorkflowInstance`/`WorkflowStep` state, preserving
the DomainEvent (what happened) vs AuditEvent (who did what) vs execution-state (how
orchestration progressed) separation.
