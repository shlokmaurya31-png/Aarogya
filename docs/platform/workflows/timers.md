# Timers

Timers are **durable database rows** (`WorkflowTimer`), not in-memory setTimeouts.
Correctness never depends on a continuously-running process: a crashed or restarted
process loses no timers, and a delayed timer simply fires on the next tick.

## Kinds

- `DELAY` — a `TIMER` step's wait. When it fires, its step is completed and the
  instance moves `WAITING → RUNNABLE` and resumes.
- `SLA` — a companion to a `TASK` step with an SLA. When it fires it **escalates**
  only if the task is still unresolved (see [slas](slas.md)).

## Firing (guarded claim)

`processDueWorkflowTimers` (inside `tickWorkflows`) selects `PENDING` timers with
`availableAt <= now`, then claims each with a guarded conditional UPDATE
(`PENDING → CLAIMED` + a per-claim token). Two workers cannot both fire the same
timer — exactly one wins (gate Race 3). A firing that throws releases the claim
(`CLAIMED → PENDING`) so a later tick retries it; a timer is never lost.

## Idempotency

Every timer carries an `idempotencyKey` (e.g. `${stepId}:sla`, `${stepId}:timer`),
so a step re-execution creates one timer, and the effect a fired timer produces (an
escalation task) is itself idempotent (`${timerId}:escalation`). A timer claimed or
processed twice yields one effective execution.

## Bounds

Timer durations are validated at publication: positive and `<= MAX_TIMER_SECONDS`
(30 days). See [security](security.md).

## Cancellation

Cancelling an instance cancels its pending/claimed timers
(`PENDING|CLAIMED → CANCELLED`), so a cancelled workflow never fires a stale timer
(see [recovery](recovery.md)).
