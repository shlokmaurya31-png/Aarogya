# Integration Control Plane — Operational Runbook

Phase C6. For hospital administrators and platform operators.

Workspace: **`/hospital-os/integrations`** (Hospital OS → Integrations).

---

## 1. What this screen answers

| Question | Where |
|---|---|
| What integrations exist? | Integrations |
| Which environment is each using? | Integrations → detail |
| Is it switched on? Can it dispatch? | Integrations → detail |
| Is it contract-verified? Sandbox-verified? Production-verified? | Readiness |
| What counterparties are configured, and are they trusted? | Participants |
| What is running, what failed, what needs review? | Exchanges / Failures |
| What callbacks arrived, and which were rejected? | Callbacks |
| What is expiring or misconfigured? | the alert banner, on every tab |
| Who changed what, when? | Configuration → history |

Readiness is **never** shown as a single word. Six dimensions are always
displayed separately, because "Ready" is exactly the label that would let
somebody point a hospital at a live national gateway on the strength of a green
dot.

---

## 2. Onboarding an integration

1. **Integrations → select the system → Configuration.**
2. Set the environment (`LOCAL`, `SANDBOX`, `PRODUCTION`), the base URL, and the
   **name of the environment variable** holding the client id.
   > Never paste a client secret, token, certificate or key anywhere in this
   > screen. The API rejects any request whose body carries a credential-shaped
   > key or PEM material, and the database has no column to put one in.
3. Set the actual credentials as environment variables in the deployment.
4. **Enable** the integration.

Configuring is deliberately separate from enabling, and both are audited.

### What configuration resets

Any accepted configuration change **clears** production approval and both
verification timestamps, and switches the integration **off**. Evidence gathered
against the old configuration says nothing about the new one, and a
`SANDBOX_VERIFIED` badge that survived a base-URL change would be a lie.

---

## 3. Going to production

Production requires **two people**:

| Step | Who | Permission |
|---|---|---|
| Configure environment `PRODUCTION` | facility admin | `interop:connection:manage` |
| Approve the move | a **different** user | `interop:integration:approve` |
| Enable | facility admin | `interop:connection:manage` |

The service refuses an approval from the same user who last configured the
integration. `HOSPITAL_ADMIN` deliberately does **not** hold
`interop:integration:approve`; `AAROGYA_ADMIN` does, and holds nothing else
operational.

Approval validates the **stored** configuration. Whether the deployment
currently holds working credentials is a separate question, answered at dispatch
time — so an approved production integration with no credentials in the process
still dispatches nothing, and says so.

Production is never inferred from a URL, from the presence of credentials, or
from a successful sandbox run.

---

## 4. Disabling an integration (kill switch)

**Disabling is deliberately easy.** One permission, no step-up, no approval,
always allowed, always audited. During an incident the fail-safe direction must
never be obstructed. A stale session can still disable.

**Enabling is deliberately hard.** Step-up authentication, valid configuration,
a verified contract, and for production a separate approver.

- Integrations → select → **Disable**, with a reason (mandatory).
- Pass `mode: "EMERGENCY"` for an urgent shutdown; it audits as
  `hospital.interop.emergencyShutdown` and raises a `CRITICAL` alert.
- Disabling **never deletes** an exchange record. In-flight work is left visible
  exactly as it was; what stops is the creation of new dispatches.
- A disabled integration also refuses **inbound** data. The kill switch is not
  outbound-only.
- Disabling twice is success, not an error.

A facility admin can disable only their own facility. There is no path by which
facility A affects facility B.

---

## 5. Participants

**Identity is not trust.** `externalId` says who a counterparty claims to be;
`trustStatus` says whether this facility relies on that claim.

- Every participant is created `UNVERIFIED`, including one created from an
  inbound message. Nothing but an explicit, step-up-gated operator action
  changes that.
- Only an `ACTIVE` + `VERIFIED` participant can be exchanged with. The outbound
  gate refuses `UNVERIFIED`, `SUSPENDED` and `REVOKED` alike.
- `REVOKED` is terminal. Re-trusting a revoked counterparty requires a
  deliberate new record.
- A participant code in `SANDBOX` and the same code in `PRODUCTION` are
  **different rows**. Sandbox trust is never inherited by a live exchange.

Every trust change requires a note, including verification.

---

## 6. Retrying a failed exchange

Exchanges → **Failures**. Each row shows its category, attempt count, next retry
and whether retry is permitted.

Retry is bound by the **same category rules** as automatic retry:

| Retryable | Not retryable |
|---|---|
| `NETWORK`, `TIMEOUT`, `RATE_LIMIT`, `EXTERNAL_SYSTEM` | `CONSENT`, `AUTHORIZATION`, `AUTHENTICATION`, `VALIDATION`, `PROTOCOL`, `DUPLICATE`, `CONFLICT`, `CONFIGURATION`, `CERTIFICATE`, `UNKNOWN` |

An operator cannot retry a consent or authorization refusal by clicking harder.
Those are not transient conditions, and a retry button that overrode them would
be a consent bypass. `UNKNOWN` is not retryable either: "we do not know what
happened" is not a reason to resend clinical data.

Retry reuses the original correlation and idempotency identity — it delegates to
the protocol module that owns the exchange rather than opening a second path to
the outside world.

### Dead exchanges

An exchange that exhausts its retry budget becomes **`REQUIRES_REVIEW`**, never
silently discarded, and raises a `RETRY_EXHAUSTED` alert. Resolve the underlying
cause and start a new exchange; there is no override.

---

## 7. Callbacks

Callbacks → shows integration, kind, correlation, accepted/rejected and reason.
Bodies are stored as a **hash and a size**, never in full.

| Status | Meaning | Action |
|---|---|---|
| `ACCEPTED` | correlated and applied | none |
| `DUPLICATE` | replay of an event already processed | none; the first delivery applied |
| `UNMATCHED` | correlation matches no exchange we created | none — no state was touched. Investigate if repeated. |
| `REJECTED` / `CONFLICT` | failed validation or arrived after a terminal state | investigate; nothing was applied |

There is deliberately **no "replay this callback" button**. Re-applying an
arbitrary external message on operator demand would be a state-corruption tool.

---

## 8. Certificates

Certificates hold **safe metadata only**: subject, issuer, serial, fingerprint,
validity dates, and a *reference* to where the material lives. No private key,
no certificate body, no passphrase — and the API returns
`materialConfigured: true/false` rather than even the storage path.

| Status | Meaning |
|---|---|
| `NOT_CONFIGURED` | no reference set |
| `VALID` | inside its validity window, more than 30 days remaining |
| `EXPIRING` | 30 days or less remaining — raises a `WARNING` alert |
| `EXPIRED` | past `notAfter` — raises a `CRITICAL` alert |
| `INVALID` | before `notBefore`, or a reference with no parsed metadata |

A reference that has never been inspected reports `INVALID`, not `VALID`.
Claiming validity for something never examined is the kind of unearned label
this phase exists to prevent.

### Rotation

Register a `NEXT` certificate with an `activatesAt`, then **Activate next**.

> This updates **Aarogya's record** of which certificate is in use. It does not
> install anything. Changing the material in the deployment's secret store is a
> separate operator action, and the API response says so explicitly. There is no
> fake rotation success.

The superseded certificate is retired, never deleted.

---

## 9. Alerts

Deterministic and rule-based. Every alert names the rule that fired; there is no
anomaly detection and no model.

`CERTIFICATE_EXPIRING` · `CERTIFICATE_EXPIRED` · `CONFIGURATION_MISSING` ·
`REPEATED_FAILURE` · `RETRY_EXHAUSTED` · `CALLBACK_REJECTED` ·
`RECONCILIATION_MISMATCH` · `INTEGRATION_DISABLED` · `UNSAFE_ENVIRONMENT`

A repeating condition increments a counter on one open alert rather than
flooding the list — enforced by a unique constraint, so it holds under
concurrent detection. Resolving an alert requires a note; `RESOLVED` is
terminal, and a condition that returns reopens the alert with the counter
preserved.

---

## 10. Incident response

1. **Stop the bleeding.** Integrations → Disable, `mode: EMERGENCY`. No step-up
   required, takes effect immediately for both outbound and inbound.
2. **Get the correlation id** from Exchanges.
3. **Reconstruct** with the exchange timeline: created → authorized →
   dispatched → callback → retry → failure → completion. Metadata only; no
   payload.
4. **Pull the audit trail**: `hospital.interop.*` events carry actor, facility,
   category and counts — never credentials or clinical content.
5. **Check the callback ledger** by correlation id.
6. **Re-enable** only after the cause is understood. Enabling re-derives
   readiness at that moment, so it will refuse if configuration has drifted.

### External outage

An external outage shows as `NETWORK`, `TIMEOUT` or `EXTERNAL_SYSTEM` failures
with bounded automatic retry. Nothing needs to be done unless retries exhaust,
at which point exchanges become `REQUIRES_REVIEW` with an alert. Do **not**
disable the integration for a transient outage — that converts retryable
failures into a manual backlog.

---

## 11. Permissions

| Action | Permission | Step-up | Break-glass |
|---|---|---|---|
| View status, exchanges, participants | `interop:overview:view` | no | **no** |
| Configure | `interop:connection:manage` | yes | **no** |
| Enable | `interop:connection:manage` | yes | **no** |
| Disable | `interop:connection:manage` | **no** (fail-safe) | **no** |
| Approve production | `interop:integration:approve` | yes | **no** |
| Manage participants | `interop:participant:manage` | no | **no** |
| Verify participant trust | `interop:participant:verify` | yes | **no** |
| Manual retry | `interop:exchange:retry` | yes | **no** |

Break-glass unlocks **nothing** in the control plane. An emergency is a reason
to read a chart; it is never a reason to reconfigure a national gateway, enable
production, or trust a counterparty.

Viewing exchange status does **not** grant access to the clinical or financial
payload the exchange carried. That remains a separate authorization against the
patient, through the C4 engine, on the clinical or claims surface.
