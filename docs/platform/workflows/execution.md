# Execution

## Model

A published version is a **bounded linear pipeline** of steps. A linear pipeline is
a constrained graph: acyclic by construction, so complexity bounds and loop
prevention are trivial to guarantee. On trigger, the engine creates one
`WorkflowInstance` plus its `WorkflowStep` rows (all `PENDING`), then runs it.

## Instance runner

`runInstance` claims the instance with a guarded conditional UPDATE
(`RUNNABLE → RUNNING` + a per-run `claimToken`). Only one worker can own an instance
at a time, which **subsumes per-step races** (gate Race 2). It then advances steps
in order:

- **CONDITION** — evaluate against the (allow-listed) context. If false, mark the
  step complete, `SKIP` the remaining steps, and complete the instance.
- **TASK** — create a `WorkflowTask` (idempotent on `${stepId}:task`); if the step
  declares an SLA, also create a companion SLA timer. Continue.
- **TIMER** — create a durable delay timer, park the step `WAITING` and the instance
  `WAITING`, and stop until the [timer](timers.md) fires and re-arms the instance.
- **ACTION** — run an allow-listed action (see [actions](actions.md)). Continue.

Before every step the runner re-verifies ownership (status `RUNNING` + matching
`claimToken`), so a concurrent [cancellation](recovery.md) wins deterministically.

## Execution semantics

- **At-least-once**, never exactly-once. Every effect is idempotent (unique keys on
  instances/tasks/timers; guarded task completion). See [idempotency in the
  README](README.md) and the gate.
- The engine distinguishes: already completed, retryable failure, permanent failure,
  cancelled, and not-yet-due.

## Loop prevention

Each instance records a `depth` = one more than the max depth of any instance
sharing its `correlationId`. Because an `EMIT_DOMAIN_EVENT` action keeps the
instance's `correlationId`, an event→workflow→event chain increments `depth` until
it exceeds `MAX_INSTANCE_DEPTH` (5), at which point no further instance is created —
the chain fails safe rather than looping.

## Bounded, daemon-free advancement

`tickWorkflows({ batchSize, now })` fires due [timers](timers.md) and advances
`RUNNABLE` instances whose next step is due. It is bounded and requires no
continuously-running process; a scheduler/worker/operator drives it. Correctness
never depends on it running — work simply waits until the next tick.
