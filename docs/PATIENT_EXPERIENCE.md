# Patient Experience Platform (D11)

The Patient Experience is Aarogya's patient-facing layer: a **secure, longitudinal,
patient-controlled projection over the canonical healthcare record**. Its defining
principle: it is **never a second source of truth**. Every encounter, diagnosis,
prescription, result, invoice, payment, consent and admission remains owned by the
canonical Hospital OS / billing / diagnostics / interoperability systems. D11 reads
those systems through an authorization boundary, and lets the patient take only the
actions that legitimately belong to them.

```
PATIENT
   ↓  authenticated session (existing HMAC cookie, tokenVersion revocation)
PATIENT ACCOUNT  (User.role = PATIENT)
   ↓  Patient.userId link (one account ↔ one patient identity)
EMPI / IDENTITY  (Patient + merge chain, resolvePatientIdsForRead)
   ↓  src/lib/patient/context.ts  ← the ONE access boundary
C4 AUTHORIZATION + CONSENT / DELEGATION
   ↓
CANONICAL LONGITUDINAL RECORD  (Encounter, Order, Result, Invoice, Consent, …)
   ↓
HOSPITAL OS / BILLING / DIAGNOSTICS / PHARMACY / INTEROP
```

## Architecture: projection, not duplication

D11 adds **exactly one** persistence group — `PatientDelegation` + `PatientDelegationScope`
(family/caregiver access). Everything else is a read projection or a thin,
ownership-checked wrapper over an existing canonical service:

| Concern | Canonical owner (reused) | D11 addition |
|---|---|---|
| Identity / account | `Patient.userId`, EMPI merge (`resolvePatientIdsForRead`) | `context.ts` access resolver |
| Appointments | `bookAppointment`/`cancelAppointment` (`src/lib/hospital/appointment.ts`) | ownership-checked patient wrappers |
| Queue | `QueueEntry` | position-estimate projection |
| Records / timeline | `buildPatientTimeline`, `Encounter`/`Problem`/`Allergy` | patient-safe records projection |
| Reports | `LabResult`/`ImagingReport` (VERIFIED), `ClinicalDocument.accessPolicy` | release-gated projection + authorized retrieval |
| Prescriptions / meds | `MedicationOrder` | read-only projection (canonical status) |
| Bills | `Invoice`/`Payment` (hospital revenue cycle) | patient-safe billing DTO |
| Payments | D4 provider boundary (`isProviderConfigured`), `recordPayment`/`allocatePayment` | server-computed intent + anti-forgery guard |
| Insurance | `PatientCoverage`/`Payer`/`PreAuthorization`/`Claim` | masked, patient-safe projection |
| Consent | `InteropConsent` engine (`grantConsent(grantedBy:"PATIENT")`) | ownership-checked patient wrappers |
| ABHA / sharing | `ExternalIdentifier`, ABDM adapter (`getAbdmConfig`) | honest status projection |
| Family access | — | `PatientDelegation` (the one new model) |

No new event bus, workflow engine, config engine, identity provider, FHIR server,
appointment engine, or billing engine is introduced. No Kafka/Redis/microservice.

## Capabilities

| Capability | Source of truth | Patient action | Authorization | Audit | External dependency |
|---|---|---|---|---|---|
| Home | all below | read | `patient:self:read` (+ scope) | — | — |
| Appointments | `Appointment` | view / book / cancel / reschedule | `patient:self:manage`, self only | `hospital.appointment.*` | — |
| Queue | `QueueEntry` | view (position estimate) | `patient:self:read` | — | — |
| Records | `Encounter`/`Problem`/`Allergy`/timeline | view | `patient:self:read` + RECORDS class | — | — |
| Reports | `LabResult`/`ImagingReport`/`ClinicalDocument` | view / retrieve | `patient:self:read` + REPORTS class + release gate | — | object storage (not configured) |
| Prescriptions | `MedicationOrder` | view (read-only) | `patient:self:read` + PRESCRIPTIONS | — | — |
| Medications | `MedicationOrder` | view (canonical status) | `patient:self:read` + MEDICATIONS | — | — |
| Discharge / follow-up | `Discharge` | view | `patient:self:read` + RECORDS | — | — |
| Bills | `Invoice`/`Payment` | view | `patient:self:read` + BILLING | — | — |
| Payments | `Invoice` + D4 provider | initiate (server-computed) | `patient:self:manage`, self only | `patient.payment.initiated` | Razorpay (BLOCKED) |
| Insurance | `PatientCoverage`/`Claim` | view (masked) | `patient:self:read` + INSURANCE | — | payer API (none) |
| Consent | `InteropConsent` | view / grant / revoke / request share | `patient:self:manage`, self only | `hospital.consent.*` | consent manager (optional) |
| ABHA / sharing | `ExternalIdentifier` + ABDM | view status | `patient:self:read` | — | ABDM (BLOCKED) |
| Family access | `PatientDelegation` | invite / accept / revoke | `patient:self:manage` | `patient.delegation.*` | — |
| Profile | `Patient` | view / narrow update | `patient:self:manage`, self only | — | — |

## Patient-facing UX

Routes live under `/patient/**` behind the `PatientShell` (a simple, single nav model,
no hospital jargon). Internal enums are translated to patient language at the
presentation boundary (`experience/language.ts`) — `IN_CONSULTATION` → "In consultation",
`PARTIALLY_PAID` → "Partially paid" — the canonical enums are never renamed. Every
section is error-isolated: a failed subsystem shows "temporarily unavailable", never a
false "no appointments" / "₹0 due".

See [PATIENT_IDENTITY](PATIENT_IDENTITY.md), [PATIENT_SECURITY](PATIENT_SECURITY.md),
[PATIENT_CONSENT](PATIENT_CONSENT.md), [PATIENT_DATA_ACCESS](PATIENT_DATA_ACCESS.md).

## Known limitations & external blockers

- **Razorpay (hospital patient payments)** — not configured (creds blocked). Payment
  initiation returns `PROVIDER_NOT_CONFIGURED`; no capture path is shipped. The server
  still computes the authoritative amount and refuses any browser-asserted success.
- **ABDM / ABHA** — not configured in this environment. ABHA status honestly reports
  `EXTERNAL_CONNECTION_UNAVAILABLE`; verification is never invented.
- **Object storage** — not configured. Authorized document retrieval returns the
  authorized reference/metadata rather than streaming bytes; no unrestricted blob access.
- **Telemedicine** — surfaced only as an appointment type; no video provider is wired
  and no fake "Join call" is shown.
- **Notifications (SMS/email/WhatsApp)** — deliberately NOT built as a provider platform;
  only the communication-preference field is captured. Left to a future Notifications tier.
