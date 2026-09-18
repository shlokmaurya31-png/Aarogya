# Failure, Cancellation & Recovery

## Failure

A step failure is classified (see [retries](retries.md)). Retryable failures back
off and retry up to a bounded cap; terminal failures move the step and instance to
`FAILED` with a safe `failureCategory`/`failureMessage`. A failed instance is
**never silently deleted** — it remains fully inspectable via
`GET …/workflow-instances/[id]` and the ops panel.

## Cancellation

`cancelInstance` (platform-only, audited) is a guarded transition from any
non-terminal state (`RUNNABLE`/`RUNNING`/`WAITING`) to `CANCELLED`. It:

- stops future executable steps (`PENDING`/`WAITING` → `SKIPPED`),
- cancels pending/claimed [timers](timers.md) (→ `CANCELLED`),
- cancels open tasks (`OPEN`/`IN_PROGRESS` → `CANCELLED`),
- records who cancelled it and why, and preserves all execution history.

Cancellation is race-safe against execution: the runner re-checks ownership before
each step, so once cancelled it stops. There is **no post-cancellation execution** —
a later tick does not resume a cancelled instance (verified in the gate; Race 5
gives a deterministic terminal state).

## Manual retry / recovery

`retryInstance` (platform-only, audited) applies to a `FAILED` instance: it resets
the failed step(s) to `PENDING`, re-arms the instance to `RUNNABLE`, and runs it.
This is the sanctioned recovery path after an operator corrects the underlying
cause. It is **idempotent** — a manual retry racing an automatic retry converges to
one execution via the guarded instance claim (gate Race 4), and two concurrent
manual retries produce exactly one winner.

`recover: true` records the operation as `workflow.instance.recovered`; otherwise it
is `workflow.instance.retried`.

## Worker interruption / restart

Because instances/steps/timers are durable and claims use per-run tokens, a worker
that dies mid-execution leaves the instance in a re-claimable state; the next
`runInstance`/`tick` picks it up. Worst case is redelivery, which is safe because
every effect is idempotent.
