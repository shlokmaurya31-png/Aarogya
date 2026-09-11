# Authorization Architecture

How Aarogya decides whether an actor may reach a piece of health data.

> **Scope note.** This describes *technical controls that support* privacy and
> data-protection requirements. It is not a compliance claim, not a
> certification, and not legal advice.

## 1. The distinction everything rests on

```
AUTHORIZATION answers:  may THIS ACTOR perform THIS ACTION on THIS RESOURCE?
CONSENT       answers:  has THE PATIENT permitted THIS DISCLOSURE?
```

They are independent inputs and neither substitutes for the other:

- A doctor with every permission still may not disclose a record to an external
  organisation without consent.
- A patient's consent still does not let a billing clerk read clinical notes.

The engine enforces both separately and never lets one stand in for the other.

## 2. Layering

C4 **adds to** the existing model; it replaces nothing.

```
requireSession / requirePermission        ← Phase B RBAC, unchanged
requireFacilityStaff                      ← Phase B tenant boundary, unchanged
        │
        ▼
authorizeAccess()                         ← Phase C4: ABAC, purpose, consent,
  policy registry · relationship ·           relationship, break-glass, step-up
  consent · break-glass · step-up
```

RBAC remains the first gate. What C4 adds is the attribute, purpose, consent,
credential and break-glass dimensions that a role alone cannot express.

## 3. Evaluation order (as implemented)

| # | Layer | Failure |
| --- | --- | --- |
| 1 | Action exists in the registry | `DENY` |
| 2 | Authenticated session | caller proves this first |
| 3 | Active staff where required | `DENY` |
| 4 | **Facility boundary** | `CONFLICT` (404-shaped) |
| 5 | RBAC permission | `DENY` |
| 6 | **Step-up authentication** | `REQUIRE_STEP_UP_AUTH` |
| 7 | Relationship to patient | `CONFLICT` / `DENY` |
| 8 | Break-glass (relaxes 7 only) | `REQUIRE_BREAK_GLASS` |
| 9 | Credential / privilege | `REQUIRE_PRIVILEGE` |
| 10 | Purpose of use | `DENY` |
| 11 | Consent | `REQUIRE_CONSENT` |
| 12 | — | `ALLOW` |

Two orderings are deliberate and were changed during the C4 security gate:

**Facility before permission.** A cross-facility request must look identical to
a nonexistent record *regardless of what permissions the caller holds*, so the
response cannot be used to probe another tenant.

**Step-up with the actor checks, before consent.** Evaluating step-up after
consent let a stale-but-valid session distinguish `REQUIRE_CONSENT` from
`ALLOW` and thereby enumerate which patients had consent on file. A stale
session should learn nothing about the resource. RBAC still precedes step-up —
there is no point challenging re-authentication for something the actor could
never do anyway.

Every step can only deny or narrow. Nothing later re-opens what an earlier step
closed.

## 4. Deny by default

| Situation | Result |
| --- | --- |
| Action not in the registry | `DENY` |
| Patient not found, or in another facility | `CONFLICT` ("Not found.") |
| Unknown relationship | `CONFLICT` |
| Required consent missing / expired / revoked | `REQUIRE_CONSENT` |
| Required credential expired | `REQUIRE_PRIVILEGE` |
| Inactive or suspended staff | `DENY` |
| Authentication age unknown, step-up required | `REQUIRE_STEP_UP_AUTH` |

There is no permissive fallback anywhere in the engine.

## 5. Relationships

Derived server-side in `resolveRelationship()`. The caller cannot assert one.

| Relationship | Meaning |
| --- | --- |
| `PATIENT_SELF` | The patient's own account |
| `AUTHORIZED_DELEGATE` | Explicit delegate/guardian (modelled, not yet issued) |
| `DIRECT_CARE` | Attending on an open encounter, or an open nursing assignment |
| `FACILITY_STAFF` | Same facility, no established care relationship |
| `PLATFORM_ADMIN` | Platform administration — **not** a clinical relationship |
| `NONE` | Nothing established, including every cross-facility case |

**`PLATFORM_ADMIN` ranks below `FACILITY_STAFF`.** A platform administrator
administers the platform; that is not care, and it does not silently satisfy a
clinical policy. `AAROGYA_ADMIN` is therefore *not* a universal clinical bypass.

**`PATIENT_SELF` is its own axis.** No staff relationship satisfies a self
policy, and being the patient does not make you staff.

`DIRECT_CARE` is deliberately narrow. "Works at the hospital" is
`FACILITY_STAFF`. Routine chart access requires only `FACILITY_STAFF` — a
receptionist checking in a walk-in and a covering clinician both legitimately
need it — and the meaningful restriction is applied to sensitive resources
instead.

## 6. The policy registry

`src/lib/auth/authorize/policies.ts` holds every rule in one readable place, as
**code**. Nothing is read from the database and nothing is `eval`'d, so a policy
cannot be altered by anyone who can write a row.

Each action declares: permission, facility requirement, minimum relationship,
data class, allowed purposes, consent requirement, credential/privilege
requirement, break-glass eligibility, step-up requirement, and whether every
decision is audited.

### Credential-aware authorization, carefully

Phase B flagged that credential-aware authorization was never enforced on
clinical routes. The tempting fix — demand a credential row for every clinical
action — would deny every existing workflow, because the credentialing tables
are legitimately sparse.

So: a credential or privilege is required **only** where an action is genuinely
high-risk **and** the requirement is explicitly configured. Absence of
configuration means no requirement, never an invented one.

## 7. Data classification

`STANDARD_CLINICAL` · `SENSITIVE_CLINICAL` · `HIGHLY_SENSITIVE` · `FINANCIAL` ·
`IDENTITY` · `SECURITY`

Applied at resource/action level, not per field. No new column was added:
`ClinicalDocument.accessPolicy` already carries
`CLINICAL_STAFF | PATIENT_VISIBLE | RESTRICTED`, and a second sensitivity field
would be a competing source of truth.

### RESTRICTED documents — the C1 gap, closed

C1 recorded `accessPolicy` but never enforced it on read, so a `RESTRICTED`
document was returned to any facility staff member holding `patient:read`.

`document.read.restricted` now requires `DIRECT_CARE`. The documents route
evaluates it **once** for the whole list (the policy turns on the actor-to-
patient relationship, identical for every row) and **withholds rather than
errors**, returning `restrictedWithheld` so the UI can say "2 restricted
documents were withheld" — silently showing a shorter list is its own safety
problem.

## 8. Error semantics

| Decision | Status | Body |
| --- | --- | --- |
| `CONFLICT` | 404 | `"Not found."` |
| `DENY` | 403 | generic |
| `REQUIRE_CONSENT` | 403 | `decision` set so the UI can offer the consent flow |
| `REQUIRE_BREAK_GLASS` | 403 | `decision` set so the UI can offer emergency access |
| `REQUIRE_PRIVILEGE` | 403 | generic |
| `REQUIRE_STEP_UP_AUTH` | 401 | client must re-authenticate |

The response carries the `decision` code so a UI can offer the right next step,
but never the policy internals, the relationship, or any hint that a record
exists elsewhere.

## 9. Audit

Actions marked `auditDecision` record **every** decision, allow and deny.

Denials were originally unaudited on the `authorizeAccess` path — fixed during
the C4 gate, because a refused attempt to reach a restricted record is *more*
interesting to a reviewer than a successful one. All decisions now funnel
through one audited exit point.

Audit records who, what, why and the outcome. Never the data reached. Actor,
facility and patient all come from already-derived context, so a caller cannot
forge an entry by shaping its request.

Security events live in their own `security.*` namespace so audit access can be
permissioned separately from clinical audit.

## 10. Performance

One authorization evaluation per request, not per row. The document list is the
worked example: the decision depends on the actor-to-patient relationship, which
is constant across the list, so evaluating per document would be N identical
queries for one answer. No Redis, no cache layer.

## 11. Known limitations

- **Per-device session revocation is not implemented.** Revocation is
  all-sessions-for-a-user via `User.tokenVersion`. Per-device needs an unbounded
  session table; see `session-security.md`.
- **`AUTHORIZED_DELEGATE` is modelled but never issued.** No delegate-granting
  workflow exists yet, so the relationship is currently unreachable.
- **MFA is not configured.** Step-up enforces authentication *recency*, which is
  a real control, not MFA. Nothing reports MFA as verified.
- **Not every route is migrated.** High-value paths (documents, FHIR export)
  use the engine. Migrating all 300+ routes was explicitly out of scope.
