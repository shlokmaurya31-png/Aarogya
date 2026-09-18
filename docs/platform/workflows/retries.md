# Retries

## Classification

Every step failure is classified into a category:

```
TRANSIENT · TIMEOUT · CONFLICT · RATE_LIMIT   → retryable
VALIDATION · AUTHORIZATION · NOT_FOUND · PERMANENT · UNKNOWN → terminal
```

`classifyWorkflowError` honors explicit markers (`WorkflowError.category`, and the
D6 event system's `retryable` flag), then falls back to HTTP-shaped status codes
(400/422 → VALIDATION, 401/403 → AUTHORIZATION, 404 → NOT_FOUND, 409 → CONFLICT,
429 → RATE_LIMIT). Unknown thrown values are `UNKNOWN`.

## Policy

- Only retryable categories are retried. **Authorization, validation, tenant, and
  policy failures are never retried** — retrying them can never succeed.
- Retries are bounded: `min(step.maxAttempts, LIMITS.MAX_RETRIES=8)` with **bounded
  exponential backoff** (30s base, 1h cap) written to the step's `availableAt`.
- On a retryable failure the step stays `PENDING` (with a future `availableAt`) and
  the instance returns to `RUNNABLE`; the next [tick](execution.md) re-runs it once
  due.
- When retries are exhausted or the failure is terminal, the step becomes `FAILED`
  and the instance becomes `FAILED` with a safe `failureCategory`/`failureMessage`.

## No infinite loops

Backoff plus the bounded attempt cap guarantees a permanently-failing step
dead-ends at `FAILED` rather than retrying forever. Automatic retry and operator
[manual retry](recovery.md) converge via the guarded instance claim (gate Race 4).
