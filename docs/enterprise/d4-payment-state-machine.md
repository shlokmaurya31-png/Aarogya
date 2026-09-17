# D4 — payment state machine

Provider callbacks are unordered and non-unique, so transitions are an explicit
allow-list (`paymentState.ts`). Anything not listed is refused; the caller then
records the condition and routes it to reconciliation rather than overwriting
canonical state.

Attempt: INITIATED → {PENDING, SUCCEEDED, FAILED, CANCELLED}; PENDING →
{SUCCEEDED, FAILED, CANCELLED}; SUCCEEDED/FAILED/CANCELLED terminal.

Payment: SUCCEEDED → {PARTIALLY_REFUNDED, REFUNDED, VOID}; PARTIALLY_REFUNDED →
{REFUNDED}; REFUNDED/VOID terminal.

Dangerous transitions that are therefore impossible: SUCCEEDED→PENDING,
SUCCEEDED→FAILED, REFUNDED→SUCCEEDED, FAILED→SUCCEEDED. VERIFIED by unit tests and
by the webhook out-of-order test (a stale `payment.failed` after a capture never
reverts a SUCCEEDED attempt).
