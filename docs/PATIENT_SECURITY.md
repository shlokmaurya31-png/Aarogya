# Patient Experience — Security & Privacy (D11)

D11 inherits the full platform security model (HMAC session, `tokenVersion`
revocation, C4 authorization, tenant isolation, `AuditEvent`) and adds nothing that
can bypass it. The patient portal is not an alternate clinical console: staff/admin
roles are refused, and a patient authorizes only actions over their own — or
explicitly delegated — record.

## The identity boundary (src/lib/patient/context.ts)

Every patient route resolves its patient scope through this single module and never
trusts a browser-supplied `patientId`/`userId`/`facilityId`/`delegateId`.

```
authenticated session → requirePatientContext (role + non-revoked)
                      → resolveReadScope(requestedPatientId?)   ← 404-shaped if not accessible
                      → assertClass(scope, DATA_CLASS)          ← delegated-scope gate
                      → canonical query filtered by scope.patientIds
```

- **SELF** access — the caller's own `Patient` (via `Patient.userId`), merge-aware.
- **DELEGATE** access — another patient who granted access; bounded to the delegation's
  scopes, ACTIVE + unexpired only, **read-only**.
- Unauthorized/cross-account/fabricated targets are reported **404-shaped**
  (`NotFoundError`) — "you may not see this" is indistinguishable from "this does not
  exist" (anti-enumeration).

## Adversarial test results (scripts/verify-postgres-d11-patient-experience.ts)

35/35 assertions pass on **both** SQLite and PostgreSQL. Coverage:

| # | Attack | Result |
|---|---|---|
| 1 | Arbitrary `patientId` (another patient) | 404-shaped, denied |
| 2 | Fabricated `patientId` | 404-shaped, denied |
| 3 | Cross-patient invoice read | never returned |
| 4 | Draft (unverified) lab result surfaced to patient | never returned |
| 5 | RESTRICTED / CLINICAL_STAFF document surfaced | never returned |
| 6 | Cross-patient document download | 404-shaped, denied |
| 7 | Forged payment amount (client-supplied) | ignored — amount computed server-side |
| 8 | Pay another patient's invoice | 404-shaped, denied |
| 9 | Browser-asserted payment success | refused (`EXTERNAL_VERIFICATION_REQUIRED`) |
| 10 | Mass assignment (`facilityId`/`uhid`/`registrationStatus`) | rejected by strict schema |
| 11 | Cross-facility doctor booking | 404-shaped, denied |
| 12 | Concurrent same-slot booking | exactly one wins (advisory lock / serialized) |
| 13 | Cancel another patient's appointment | 404-shaped, denied |
| 14 | Grant another patient's consent | 404-shaped, denied |
| 15 | Invite with an un-modelled scope | rejected (closed allow-list) |
| 16 | Delegate invites over the grantor's record | denied (not self) |
| 17 | Delegate access before accept | denied |
| 18 | Invite token replay after accept | denied (token burned) |
| 19 | Delegate reads out-of-scope class (billing) | denied |
| 20 | Delegate takes an action | denied (read-only) |
| 21 | Revoked delegation | access lost immediately |
| 22 | Expired delegation | no access |
| 23 | Concurrent accept of one invite | exactly one wins (guarded CAS) |
| 24 | ABHA fake linkage/verification | honest unavailable state |

## Authorization

- Base gate: `patient:self:read` (a PATIENT-role account). Mutations additionally
  require `patient:self:manage`. Neither is ever granted to staff roles.
- Delegated reads are gated per data class (`assertClass`): a delegation scoped to
  `APPOINTMENTS` cannot read billing, records, reports, etc.
- Actions (`resolveActScope`) are **self only** — a delegate is strictly read-only and
  cannot escalate to acting.

## Payments (anti-forgery)

- The amount is always `Invoice.totalMinor − allocatedMinor`, computed server-side; the
  request body carries only an `invoiceId` (a client amount is never read).
- A patient can only pay their own invoice (ownership + `scope.isSelf`).
- An invoice is **never** marked paid on a browser callback. The only path to a
  canonical `Payment` is a provider-verified server-side callback (`recordPayment` +
  `allocatePayment`), which does not exist until a real gateway is wired. Until then,
  initiation returns `PROVIDER_NOT_CONFIGURED` and confirmation is refused.

## Input safety / mass assignment / IDOR

- Every mutating route uses a `.strict()` Zod schema and explicit field mapping — the
  request body is never spread into a Prisma write.
- Delegation scopes and relationships are closed allow-lists.
- All queries are parameterized via Prisma (no string SQL) — SQL injection and prototype
  pollution are structurally prevented.
- Document retrieval never exposes a raw storage URL or accepts a client path; it
  re-verifies ownership + release + classification server-side.

## Audit

Sensitive patient operations reuse the existing `AuditEvent` system (no second audit
store): account linking, delegation invite/accept/revoke, consent grant/revoke, payment
initiation, appointment create/cancel. Aggregate reads are not audited (hot path).

## Session security

Sessions are the existing HMAC cookie; `User.tokenVersion` is the revocation mechanism
(logout-all / password change / admin revoke invalidate every cookie). A delegate's
access additionally ends the instant the grantor revokes or the delegation expires —
enforced at read time, independent of any sweep.
