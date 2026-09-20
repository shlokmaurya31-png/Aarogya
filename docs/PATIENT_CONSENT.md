# Patient Consent & Family Delegation (D11)

D11 exposes two distinct, rich consent surfaces to the patient — never a boolean.

## 1. Health-information sharing consent (reuses `InteropConsent`)

The patient's consent to share a bounded class of their records with a named recipient,
for a purpose, until an expiry. D11 does not create a new consent model — it reuses the
canonical `InteropConsent` engine (`src/lib/hospital/interoperability/consent.ts`), which
already carries purpose + scope (child table) + recipient + validity + status + audit.

Patient-facing operations (`src/lib/patient/experience/consent.ts`):
- **view** — `listPatientConsents` (facility + patient scoped)
- **grant** — `grantConsent({ grantedBy: "PATIENT" })` after re-verifying the consent is
  the acting patient's own
- **revoke** — `revokeConsent` (same ownership check)
- **request sharing** — `requestConsent` then patient-grant, producing an ACTIVE consent
  the patient can revoke at any time

Every mutation is self-only and re-checks `consent.patientId === scope.patientId` before
delegating to the engine. Purpose, scope, recipient and validity are all preserved — a
valid consent for a different purpose/recipient/scope never authorizes a different
exchange (enforced by the existing `assertExchangeAuthorized`).

## 2. Family / caregiver delegated access (`PatientDelegation`)

The one new persistence group in D11. A patient (grantor) authorizes another Aarogya
user (delegate) to **read** a bounded set of their record.

```
PatientDelegation
  patient (grantor)  →  delegate (User, null until accepted)
  relationship: PARENT | CHILD | SPOUSE | GUARDIAN | CAREGIVER | OTHER
  status: INVITED → ACTIVE → REVOKED | EXPIRED
  inviteTokenHash (SHA-256 only; token never stored), inviteExpiresAt
  expiresAt, acceptedAt, revokedAt
  scopes[]  ← PatientDelegationScope (APPOINTMENTS|RECORDS|REPORTS|
              PRESCRIPTIONS|MEDICATIONS|BILLING|INSURANCE|CONSENT)
```

### Lifecycle & invariants

- **Invite** (`inviteDelegate`) — grantor only. Scopes and relationship are validated
  against closed allow-lists. Returns a single-use token **once** for out-of-band
  delivery; only its hash is stored.
- **Accept** (`acceptDelegation`) — binds the authenticated caller as delegate, ACTIVE,
  **without changing scope**. Guarded (`status + version` CAS) so concurrent accepts
  can't double-apply; the token is burned on success (no replay). A user cannot accept a
  delegation over their own record.
- **Revoke** (`revokeDelegation`) — grantor only, own delegation only, guarded.
- **Read access** (`listAccessiblePatients`) — returns a delegation ONLY while `status =
  ACTIVE` and `expiresAt` is null/future. Revocation and expiry therefore take effect
  immediately, independent of any background sweep.

### Security guarantees (see PATIENT_SECURITY §7)

A delegate can never: grant themselves access, escalate their own scope, act on the
record (read-only), read an out-of-scope class, or retain access after revoke/expiry.
Scope is fixed at invite; acceptance binds a user, it does not widen the grant. All of
these are proven in the D11 gate.

## Anti-enumeration

Invitation lookups are by token hash; a miss and a scope/ownership failure are
indistinguishable (404-shaped). No endpoint reveals whether an arbitrary person is a
patient.
