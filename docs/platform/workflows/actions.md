# Actions

Workflow definitions can **never call arbitrary functions**. Every action is
allow-listed in `src/lib/workflows/actions.ts` with a strict parameter schema, and
execution runs through existing domain services with their normal
authorization/tenant/audit controls.

## Step types vs the action registry

The engine's step types are `CONDITION`, `TASK`, `TIMER`, `ACTION`.

- `TASK` and `TIMER` are first-class step types with structured config; internally
  they use the registry's `CREATE_TASK` / `START_TIMER` implementations.
- An `ACTION` step may name only actions flagged `invokableFromDefinition`.

## Registry

| Action | Invokable from a definition? | Purpose |
|---|---|---|
| `CREATE_TASK` | No (driven by `TASK` steps / SLA escalation) | Create an orchestration task |
| `COMPLETE_TASK` | No (operator/task-service action) | Complete a task |
| `ASSIGN_TASK` | No | Assign a task |
| `START_TIMER` | No (driven by `TIMER`/`SLA`) | Create a durable timer |
| `EMIT_DOMAIN_EVENT` | **Yes** | Emit a catalogued D6 event, causally linked |
| `UPDATE_WORKFLOW_STATE` | **Yes** | Deterministic state marker (a hook for future providers) |

`EMIT_DOMAIN_EVENT` params are validated (`{ eventType, aggregateId?, payload }`) and
the target `eventType` must itself be a known D6 catalogue event; the emitted event
preserves the instance's correlation chain and cites the trigger event as its cause.

## Clinical/financial safety boundary

The registry deliberately exposes **no** clinical or financial mutation action
(no order/prescribe/administer/dispense/payment/refund/discharge/etc.). A workflow
therefore cannot gain clinical or financial authority by existing — a canonical
mutation still runs behind its own service and C4/consent/invariant checks. See
[security](security.md).
