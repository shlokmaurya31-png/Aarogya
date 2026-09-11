# NHCX Claims Exchange — Error Model

Phase C5. Source of truth: `src/lib/hospital/nhcx/errors.ts`.

Mirrors the C2 interoperability error model rather than inventing a second
vocabulary: the job is identical — turn every external failure into one internal
classification, and decide retry safety from the **class**, not from the message.

Retry safety here is a correctness control, not a convenience. A claim
submission that partially applied at the payer and is blindly retried creates a
**duplicate claim** — a financial error, not a glitch.

---

## 1. Categories and retry safety

| Category | Retryable | Meaning |
|---|---|---|
| `VALIDATION` | no | the payload is wrong; resending it will be wrong again |
| `AUTHENTICATION` | no | our credentials are wrong or expired |
| `AUTHORIZATION` | no | we are not permitted to do this |
| `RATE_LIMIT` | **yes** | back off harder (60 s base) |
| `NETWORK` | **yes** | transient connectivity |
| `TIMEOUT` | **yes** | no answer within the window |
| `PROTOCOL` | no | contract mismatch, including `NOT_IMPLEMENTED` |
| `DUPLICATE` | **no** | the far side already has it — see §2 |
| `CONFLICT` | no | a state clash that a resend will not resolve |
| `EXTERNAL_SYSTEM` | **yes** | 5xx at the exchange |
| `CONFIGURATION` | no | an operator must act |
| `UNKNOWN` | no | an unclassified failure is never assumed safe |

Only genuinely transient categories retry. `UNKNOWN` deliberately does not:
"we don't know what happened" is not a reason to send money-bearing clinical
data again.

---

## 2. Why `DUPLICATE` is not retryable

A `DUPLICATE` response means the external side **already has** the request.
Resending is precisely what would create a second claim at the payer. The
correct recovery is to reconcile against what the payer holds, or to correct the
claim and submit it as a **new version** — which produces a new idempotency key
and is therefore allowed through.

`retryExchange()` enforces this: a non-retryable category is refused with
*"A `<CATEGORY>` failure is not retryable. Correct the claim and resubmit as a
new version."*

---

## 3. HTTP status mapping

```
400, 422 → VALIDATION      408, 504 → TIMEOUT
401      → AUTHENTICATION  429      → RATE_LIMIT
403      → AUTHORIZATION   ≥ 500    → EXTERNAL_SYSTEM
404      → PROTOCOL        other    → UNKNOWN
409      → CONFLICT
```

401 and 403 are kept distinct: one means our credentials are wrong, the other
means our credentials are fine and we are not allowed. Collapsing them would
send an operator down the wrong path.

---

## 4. Backoff

```
nextRetryDelayMs(attempt, category)
  = null                              if the category is not retryable
  = min(base × 2^attempt, 30 minutes) otherwise

base = 60 s for RATE_LIMIT, 15 s otherwise
```

Bounded and capped. There is no path that retries forever: `attemptCount` is
checked against `maxAttempts` (default 3) before every retry, and `nextRetryAt`
is only set while budget remains.

---

## 5. Adapter outcomes → categories

| `NhcxOutcome` | Category | Note |
|---|---|---|
| `NOT_CONFIGURED` | `CONFIGURATION` | an operator must supply configuration |
| `NOT_IMPLEMENTED` | `PROTOCOL` | the transport contract is unverified |
| `REJECTED` | `VALIDATION` | the far side refused the content |
| `TRANSIENT_ERROR` | `EXTERNAL_SYSTEM` | retryable |
| anything else | `UNKNOWN` | not assumed safe |

---

## 6. What an error is allowed to say

`NhcxError.toPublic()` returns `{ category, message, retryable, correlationId }`
and deliberately omits `externalCode` and `httpStatus`. Protocol internals are
operator detail, visible in the exchange record and the audit trail, not
end-user detail.

Callback failures are narrower still. The route answers a **generic**
`Unauthorized.` or `Invalid callback.` — a caller that failed authentication
learns nothing about which exchanges or correlation ids exist.

---

## 7. Transport failure is not a payer decision

When a dispatch fails:

- the exchange goes to `FAILED` with its category and message
- the submission goes to `FAILED`, **not** `REJECTED`
- the canonical `Claim` is not moved to `REJECTED`

Conflating a transport failure with a rejection would misreport the claim to
every downstream consumer, including the operator deciding whether to appeal.
This is verified: *"A transport failure does not mark the canonical claim
REJECTED"* in `scripts/verify-postgres-nhcx.ts`.
