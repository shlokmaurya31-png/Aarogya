# ABDM / FHIR Access Governance

How Phase C4's trust layer governs the interoperability paths built in C1–C3.

## The rule

**No interoperability path may reach patient data without the central
authorization engine.** There is no second permission system inside FHIR or
ABDM, and no adapter may export directly.

```
FHIR export route
  → buildAuthorizationActor()      actor from the SESSION, never the body
  → requireAuthorization()         facility · RBAC · relationship · purpose · consent
  → exportPatientToFhir()          scope filtering, composition, provenance
```

## What changed in C4

| Path | Before C4 | After C4 |
| --- | --- | --- |
| FHIR export route | `requireFacilityStaff` + in-service consent | **central engine first**, then in-service consent |
| Document read | `patient:read`, RESTRICTED returned to anyone | RESTRICTED requires `DIRECT_CARE` |
| Break-glass | did not exist | exists, and cannot unlock disclosure |

The in-service consent check in `exportPatientToFhir` was **kept**. That is
defence in depth, not duplication: the engine is the gate, the service is the
belt. A future caller that reaches the service by another route is still
refused.

## Consent is evaluated once, centrally

`evaluateConsent()` in the authorization layer delegates to the C1 primitives
(`isConsentUsable`, `consentCoversAllScopes`) rather than reimplementing them.
Two consent evaluators that disagree is strictly worse than one.

What the C4 layer adds is the surrounding decision: which consent applies, and
whether it matches the purpose, recipient and scope being requested.

## Escalation is refused in all four directions

| Attempt | Result |
| --- | --- |
| TREATMENT consent used for RESEARCH | refused — purpose |
| LAB consent used for ALL_CLINICAL | refused — scope |
| Consent for org A used for org B | refused — recipient |
| Consent for patient X used for patient Y | refused — patient |

`canSharePatientData()` checks **tenant isolation before consent**, so a
valid-looking consent can never reach across a facility boundary.

## Break-glass does not touch disclosure

Every outbound action is `breakGlassAllowed: false`. An emergency justifies
reading a chart locally; it does not justify transmitting a record to a third
party without the patient's agreement.

Asserted in both the unit suite and the PostgreSQL gate: under an active
break-glass window, `patient.export.fhir` still returns `REQUIRE_CONSENT`.

## Revocation dominates the protocol

C3 established that a locally revoked consent blocks dispatch *before* the
exchange enters `PROCESSING`. C4 preserves this and adds the inverse assertion:
**even when the ABDM protocol state says `GRANTED`, a revoked local consent
blocks the transfer.**

The ABDM protocol is a transport fact. It is not an authorization source.

## Import governance

Inbound external data does not become universally visible:

- staged in `ImportedResource`, never written straight to a clinical table
- patient resolved from an existing external-identifier mapping, or a
  caller-asserted id that is verified against the facility first
- conflicts flagged `CONFLICT` for human review, never auto-merged
- provenance records origin as `EXTERNAL`, never `LOCAL`

## Audit and provenance, kept distinct

| | Answers | Namespace |
| --- | --- | --- |
| `AuditEvent` | what did Aarogya do? | `hospital.*`, `security.*` |
| `InteropProvenance` | where did this representation come from? | — |

C4 adds `security.authorization.allowed` / `.denied` for decisions on
audit-worthy actions, including **denials** — a refused attempt to reach a
restricted record is more interesting to a reviewer than a successful one.

## Still true after C4

- ABDM is **not** integrated; no authenticated operation has been performed
- no FHIR profile conformance is asserted (`conformanceAsserted: false`)
- production ABDM traffic is refused in code, not merely unconfigured
