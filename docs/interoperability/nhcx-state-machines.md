# NHCX Claims Exchange — State Machines

Phase C5. Source of truth: `src/lib/hospital/nhcx/stateMachines.ts`.

There are **three** machines and they are deliberately not merged. The canonical
billing machine is Phase 5's and is not redefined here.

---

## 1. `Claim.status` — canonical billing (Phase 5, unchanged)

```
DRAFT ──► SUBMITTED ──► UNDER_REVIEW ──► APPROVED ──────────► SETTLED ──► CLOSED
            │               │            PARTIALLY_APPROVED ──┘
            └──────────────►└──────────► REJECTED
```

Defined in `src/lib/hospital/billing/claims.ts` and enforced by
`isClaimTransitionAllowed()`. C5 reads this machine and never bypasses it.

Note what the canonical vocabulary deliberately does **not** contain:
`ACKNOWLEDGED`, `QUERY`, `RESPONSE_SUBMITTED`. Those are protocol concerns and
live on the submission and query records instead of being bolted onto billing.

---

## 2. `ClaimSubmission.status` — one submission attempt

```
DRAFT ──► READY ──► SUBMITTED ──► ACKNOWLEDGED ──► ACCEPTED
  │         │           │              │
  │         │           ├──────────────┴──► REJECTED ──► SUPERSEDED
  │         │           └──► FAILED ──┬──► SUBMITTED
  │         │                         └──► SUPERSEDED
  └─────────┴──────────────────────────────► SUPERSEDED
```

| Rule | Why |
|---|---|
| `DRAFT → SUBMITTED` is **not** allowed | pre-flight cannot be skipped |
| `READY → FAILED` is allowed | a local pre-flight failure that never left the building |
| `FAILED → SUBMITTED` is allowed | a transport failure may be retried |
| `REJECTED → SUBMITTED` is **not** allowed | a rejection needs a *new version*; resending the same package is what creates a duplicate claim at the payer |
| `ACCEPTED` and `SUPERSEDED` are terminal | history must stay reconstructable |

`ACCEPTED` means *accepted for adjudication*, not *approved*. It maps to no
canonical status.

Superseding never deletes. `buildSubmission` flips prior live submissions to
`SUPERSEDED` and creates a new row at `version + 1`, guarded by
`@@unique([claimId, version])` — under a concurrent race the losers fail on the
constraint rather than producing a duplicate version number.

---

## 3. `NhcxExchange.protocolState` — what the network said

```
NOT_SUBMITTED ──► SUBMITTED ──► ACKNOWLEDGED ──► RESPONDED
      │               │              │
      │               ├──────────────┴──► FAILED ──┬──► SUBMITTED
      │               └──► RESPONDED               └──► CANCELLED
      └──► CANCELLED / FAILED
```

`SUBMITTED → RESPONDED` skips `ACKNOWLEDGED` on purpose: an exchange can answer
directly, and requiring the intermediate step would silently drop real
responses. This is the same defect class the C3 gate found in the ABDM consent
flow.

`RESPONDED` and `CANCELLED` are terminal. A `FAILED` exchange may be retried,
subject to `attemptCount < maxAttempts` and the error category being retryable.

---

## 4. `ClaimQuery.status` — payer clarification

```
RECEIVED ──► UNDER_REVIEW ──► RESPONSE_DRAFT ──► RESPONSE_SUBMITTED
    │             │                 │                   │
    └─────────────┴─────────────────┴──► CLOSED         ├──► ACKNOWLEDGED ──► RESOLVED
                                                        └──► RESOLVED
```

Structured rather than a chat thread: every response is versioned, audited and
individually authorized, which a free-form message log would not be.

`RESPONSE_SUBMITTED → CLOSED` is not allowed; an answered query resolves, it does
not get closed out from under the answer.

---

## 5. `ClaimSettlement.status`

```
NOTIFIED ──► RECONCILED
    │  └──► DISPUTED ──► RECONCILED / REJECTED
    └──► REJECTED
```

`RECONCILED` is **terminal**. Undoing a reconciliation would silently move money.

---

## 6. `ReconciliationException.status`

```
OPEN ──► ACKNOWLEDGED ──► RESOLVED / DISMISSED
  └──────────────────────► RESOLVED / DISMISSED
```

`RESOLVED` and `DISMISSED` are terminal, and both require a resolution note.

---

## 7. Mapping protocol events onto canonical billing

`canonicalStatusForSubmission(status)`:

| Submission status | Canonical claim status | Reasoning |
|---|---|---|
| `SUBMITTED` | `SUBMITTED` | it has left the building |
| `ACKNOWLEDGED` | `UNDER_REVIEW` | the payer has it and is looking at it |
| `REJECTED` | `REJECTED` | a payer decision |
| `DRAFT` `READY` `ACCEPTED` `FAILED` `SUPERSEDED` | `null` | says nothing about billing state |

`canonicalStatusForAdjudication(outcome)`:

| Outcome | Canonical | Reasoning |
|---|---|---|
| `APPROVED` | `APPROVED` | |
| `PARTIALLY_APPROVED` | `PARTIALLY_APPROVED` | |
| `REJECTED` | `REJECTED` | |
| `PENDING` `QUERY` | `UNDER_REVIEW` | not decisions |
| anything else | `null` | never guessed |

`syncCanonicalClaimStatus()` then re-checks the move against Phase 5's own
transition table and performs a guarded `updateMany`. If billing does not permit
the move, the protocol record keeps the truth and the claim is left alone.
