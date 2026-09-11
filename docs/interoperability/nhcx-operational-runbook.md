# NHCX Claims Exchange — Operational Runbook

Phase C5. For hospital billing operators and platform operators.

> **Current state:** no NHCX transport is implemented. Everything below about
> packaging, versioning, queries, settlements and reconciliation works today.
> Everything about *transmission* will begin working when the transport contract
> is verified and the adapter is implemented. The workspace says so on every tab
> rather than looking operational while nothing can be sent.

---

## 1. Where things are

| Screen | Path |
|---|---|
| Claims worklist (Phase 5, manual payer decisions) | `/hospital-os/claims` |
| Claims Exchange workspace | `/hospital-os/claims/exchange` |

The two are deliberately separate entries under **Billing** so that *"we have not
sent this"* never looks like *"they have not answered"*.

Workspace tabs: Overview · Pre-Flight · Submissions · Exchanges · Queries ·
Settlements · Exceptions · Exchange Health.

---

## 2. Normal flow

1. **Pre-Flight** — select a claim. The checklist shows **blockers** (red) and
   **warnings** (amber) separately. Blockers disable the build control, and the
   server refuses too; the button is not the only guard.
2. **Build submission package** — composes an immutable, versioned snapshot from
   canonical records and hashes it. Requires consent (`INSURANCE`) and a recent
   authentication.
3. **Submissions → Dispatch** — attempts transmission. Today this records an
   honest `NOT_CONFIGURED` / `NOT_IMPLEMENTED` outcome and leaves a durable
   exchange record.
4. **Queries** — payer questions appear here. Answering attaches documents that
   are authorized one at a time; refused ones are listed back, never omitted
   silently.
5. **Settlements** — record the payer advice reference and amount.
6. **Exceptions** — work the discrepancies reconciliation found.

---

## 3. Common situations

### "Submission is blocked"

Read the Pre-Flight blockers. The usual ones:

| Blocker | Action |
|---|---|
| `Coverage has expired.` | Add current coverage in Billing, then rebuild. Do not submit against expired coverage — it is a predictable rejection and a reconciliation problem later. |
| `Coverage belongs to a different patient.` | The claim is attached to the wrong coverage row. Fix in Billing. |
| `Coverage is <STATUS>.` | Only `ACTIVE` coverage may be claimed against. |
| Pre-authorization problems | Obtain or correct the pre-auth first. |

### "A correction reason is required when resubmitting a claim"

Expected. Version 1 needs no reason; every later version does, because the
reason is what makes the version history auditable.

### "A `<CATEGORY>` failure is not retryable"

Correct behaviour. `VALIDATION`, `AUTHENTICATION`, `AUTHORIZATION`, `PROTOCOL`,
`DUPLICATE`, `CONFLICT` and `UNKNOWN` cannot succeed on retry. Correct the claim
and **build a new version** — that produces a new idempotency key and is allowed
through. Never work around this; see
[`nhcx-error-model.md`](./nhcx-error-model.md) §2.

### "This exchange has exhausted its 3 attempts"

Investigate the recorded `errorCategory` / `errorMessage` on the Exchanges tab.
Resolve the cause, then resubmit as a new version. There is no override.

### "Re-authentication is required for this action"

Both composing and dispatching a payer package require a recent authentication
(default 15 minutes). Re-authenticate and retry.

### "No matching consent was found"

The patient has no granted `INSURANCE`-purpose consent covering `BILLING`, or it
was revoked. This is not a bug. Obtain consent; a revoked consent stops all
future disclosure while leaving what was already sent on record.

---

## 4. Callback problems

| Symptom | Meaning | Action |
|---|---|---|
| `401 Unauthorized` | wrong or missing `x-nhcx-callback-token`, **or** none configured | check `NHCX_CALLBACK_TOKEN`. An unset token refuses every callback by design. |
| `UNMATCHED` | the correlation id matches no exchange we created | none — no claim state was touched. Investigate if repeated; the event is audited. |
| `DUPLICATE` | a replay of an event already processed | none. The first delivery already applied. |
| `400 Invalid callback` | bad JSON, missing/stale timestamp, oversized body | the sender must correct it. Accepted skew is ±10 minutes; max body 2 MB. |

A callback body can never nominate its own facility, patient, claim or
correlation. Those are resolved from the exchange **we** created.

---

## 5. Reconciliation

- A settlement notification is **evidence, not a payment**. Recording one never
  moves money. The canonical receipt is still entered in Billing → Payments with
  method `INSURANCE_SETTLEMENT`.
- The same reference notified twice with the **same** amount is deduplicated
  silently. With a **different** amount it raises a `CRITICAL`
  `DUPLICATE_SETTLEMENT` exception and the stored amount is not overwritten.
- `Reconcile claim` scans for `MISSING_SETTLEMENT`, `OVERPAYMENT`,
  `UNDERPAYMENT`, `AMOUNT_MISMATCH` and `ORPHAN_EXTERNAL_REFERENCE`. It reports;
  it never corrects.
- Resolving an exception requires a note. `RECONCILED` and `RESOLVED` are
  terminal.

---

## 6. Configuration

All variables are optional. With none set, `NHCX_ENVIRONMENT` is `DISABLED` and
billing, invoicing, payments and refunds are entirely unaffected.

| Variable | Purpose |
|---|---|
| `NHCX_ENVIRONMENT` | `DISABLED` \| `LOCAL` \| `SANDBOX` \| `PRODUCTION` |
| `NHCX_BASE_URL` | exchange base URL |
| `NHCX_PARTICIPANT_CODE` | our participant code |
| `NHCX_CLIENT_ID` / `NHCX_CLIENT_SECRET` | credentials |
| `NHCX_CALLBACK_URL` | must be `https://` |
| `NHCX_CALLBACK_TOKEN` | inbound shared secret; unset ⇒ all callbacks refused |
| `NHCX_CERTIFICATE_PATH` / `NHCX_PRIVATE_KEY_PATH` | **references only**, never key material |
| `NHCX_REQUEST_TIMEOUT_MS` | clamped to 1 s – 120 s |

> These names are **Aarogya's own** and are provisional. They are not a claim
> about what NHCX requires — the onboarding parameters are part of the transport
> contract this phase could not verify. See
> [`nhcx-contract-matrix.md`](./nhcx-contract-matrix.md).

Fail-closed rules enforced by `checkNhcxEnvironmentSafety()`:

- an unrecognised `NHCX_ENVIRONMENT` is `DISABLED`, never guessed
- `NODE_ENV=production` pointed at `SANDBOX`/`LOCAL` is **unsafe**
- non-production pointed at `PRODUCTION` is **unsafe**
- a selected environment with missing credentials is **unsafe**

Secrets never appear in logs, API responses or the UI. `describeNhcxConfig()`
reports only *whether* a value is present.

---

## 7. Exchange Health tab

- **Environment / Credentials / Live operations** — runtime truth. `Live
  operations: 0` means nothing can be transmitted, regardless of what the
  environment says.
- **Contract provenance** — which specification was read, when, and explicitly
  whether the transport contract was verified. It currently reads **no**.
- **Recent failures** — the last 50 failed exchanges with category and message.

---

## 8. Escalation

1. Capture the `correlationId` from the Exchanges tab.
2. Pull the audit trail: `hospital.claim.*` events carry identifiers, counts and
   the snapshot hash — never clinical payloads.
3. Pull the callback ledger by `correlationId`; bodies are stored as hash and
   size only.
4. For a financial discrepancy, open a `ReconciliationException` rather than
   adjusting a Payment directly.
