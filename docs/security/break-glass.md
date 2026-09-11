# Break-Glass Emergency Access

## What it is

A **time-boxed, reasoned, heavily audited relaxation of exactly one policy** —
the care-relationship requirement — for **one patient**, by **one actor**.

## What it is not

Break-glass is **not** an admin bypass, not a role, and not a permission. It
never bypasses:

- authentication
- facility isolation
- patient existence
- consent for external disclosure
- maker/checker on credential and privilege operations
- audit

It relaxes the policy that would otherwise refuse urgent clinical access, and
nothing else.

## The three properties that stop it becoming a backdoor

**1. It expires.** Hard ceiling of 4 hours, 1 hour by default. Expiry is derived
from the timestamp at read time, so an unswept row past its window is already
unusable — the sweep is cosmetic and safe to never run.

**2. It is narrow.** Bound to one actor *and* one patient. A colleague cannot
ride on someone else's window, and a window for patient A does nothing for
patient B. Both are verified in the security gate.

**3. It is expensive to use.** A reason of at least 20 characters is mandatory,
the emergency context comes from a closed vocabulary, every use is counted, and
every activation appears in the abuse report.

## Crucially: it does not unlock disclosure

Every disclosure action is `breakGlassAllowed: false`:

`patient.export.fhir` · `exchange.request` · `exchange.authorize` ·
`billing.export`

An emergency justifies reading a chart locally. It does **not** justify
transmitting a record to a third party without the patient's agreement. Enforced
by policy and asserted in both the unit suite and the PostgreSQL gate.

Security and administrative actions are equally ineligible: break-glass cannot
reach audit, credentialing, privilege granting, privacy requests or identity
linking.

## Eligible actions

Only read-oriented clinical access:

`patient.read` · `patient.timeline.read` · `document.read` ·
`document.read.restricted`

## Activation

```http
POST /api/hospital/security/break-glass
{ "patientId": "...", "reason": "...", "emergencyContext": "UNCONSCIOUS_PATIENT" }
```

Actor, facility and staff profile all come from the **session**. The client
supplies only the patient, a reason and a declared context — so a caller cannot
activate emergency access as somebody else or in another facility.

Activation is itself an authorized action (`breakglass.activate`): facility
membership and an active staff profile are still required.

### Emergency contexts

`LIFE_THREATENING` · `UNCONSCIOUS_PATIENT` · `MASS_CASUALTY` ·
`URGENT_TRANSFER` · `CLINICAL_HANDOVER` · `OTHER_URGENT`

Deliberately no `ADMIN_OVERRIDE` and no `CONVENIENCE`.

## Lifecycle

`ACTIVE` → `COMPLETED` (closed by its owner) · `REVOKED` (closed
administratively) · `EXPIRED` (window elapsed)

Closure is guarded so two concurrent closes cannot both win. Revocation is
separately permissioned from activation — the person who opened a window should
not be the only person able to close it.

## Audit

Every activation records actor, patient, encounter, facility, reason, declared
context, expiry and a correlation id. Every access made under the window carries
that correlation id, so the full set of records reached is reconstructable.

The reason is recorded in full: it is operator-authored text about a clinical
situation and it is the accountability record.

## Abuse reporting

Deterministic counting only — no anomaly detection, no scoring, nothing that
could be mistaken for a judgement:

- activations by actor and by patient over a window
- repeated use against the same patient
- windows still marked active but past expiry
- **windows activated and never used** (a useful signal on its own)

Available at `GET /api/hospital/security/break-glass`, which requires
`breakglass.review`.

## Verified in the security gate

- cannot cross a facility boundary
- relaxes the care-relationship requirement
- does **not** unlock external disclosure
- a colleague cannot ride on another actor's window
- a window does not extend to another patient
- an expired window stops granting access *before* it is swept
- concurrent activations each produce a distinct auditable window
- concurrent closure yields exactly one winner
- facility B cannot revoke a facility A window
