# Patient Data Access & Classification (D11)

Every patient-facing read is a **projection** over a canonical table, mapped to a
patient-safe DTO, gated by a data class, and scoped to `scope.patientIds` (merge-aware).
No endpoint returns a raw Prisma object.

## Data classes (context.ts)

| Class | Backing data | Delegation scope that grants it |
|---|---|---|
| PERSONAL | profile demographics | RECORDS |
| APPOINTMENTS | `Appointment` | APPOINTMENTS |
| QUEUE | `QueueEntry` | APPOINTMENTS |
| RECORDS | encounters, problems, allergies, timeline, discharge | RECORDS |
| REPORTS | verified `LabResult`/`ImagingReport`, PATIENT_VISIBLE `ClinicalDocument` | REPORTS |
| PRESCRIPTIONS | `MedicationOrder` | PRESCRIPTIONS |
| MEDICATIONS | `MedicationOrder` (status) | MEDICATIONS |
| BILLING | `Invoice`/`Payment` | BILLING |
| INSURANCE | `PatientCoverage`/`Claim` | INSURANCE |
| CONSENT | `InteropConsent` | CONSENT |

SELF access grants all classes (except never-patient-facing RESTRICTED clinical
documents). A delegate is granted only the classes mapped from their delegation scopes.

## Per-capability contract

| Capability | SOURCE OF TRUTH | AUTHORIZATION | PATIENT VISIBILITY | MUTATION PATH | AUDIT | EXTERNAL DEP | FAILURE STATE |
|---|---|---|---|---|---|---|---|
| Appointments | `Appointment` | self act / delegate read | active + past | canonical `bookAppointment`/`cancelAppointment` | `hospital.appointment.*` | — | Unavailable |
| Queue | `QueueEntry` | read + QUEUE | own entries + position estimate | none | — | — | Unavailable |
| Records | encounters/problems/allergies/timeline | read + RECORDS | own record only | none | — | — | Unavailable |
| Reports | verified results + PATIENT_VISIBLE docs | read + REPORTS + release gate | released only | none | — | object storage | Unavailable |
| Prescriptions | `MedicationOrder` | read + PRESCRIPTIONS | all | none (read-only) | — | — | Unavailable |
| Medications | `MedicationOrder` | read + MEDICATIONS | canonical status | none | — | — | Unavailable |
| Discharge | `Discharge` | read + RECORDS | status + pending items | none (hospital-controlled) | — | — | Unavailable |
| Bills | `Invoice`/`Payment` | read + BILLING | ISSUED/PARTIAL/PAID | none | — | — | Unavailable |
| Payments | `Invoice` + provider | self act | — | server-computed intent | `patient.payment.initiated` | Razorpay (BLOCKED) | PROVIDER_NOT_CONFIGURED |
| Insurance | `PatientCoverage`/`Claim` | read + INSURANCE | masked member id | none | — | payer API (none) | Unavailable |
| Consent | `InteropConsent` | self act / read + CONSENT | full record | canonical consent engine | `hospital.consent.*` | consent manager | Unavailable |
| ABHA | `ExternalIdentifier` + ABDM | read | masked, honest state | none | — | ABDM (BLOCKED) | EXTERNAL_CONNECTION_UNAVAILABLE |
| Family | `PatientDelegation` | self act | own grants | delegation lifecycle | `patient.delegation.*` | — | Unavailable |
| Profile | `Patient` | self act | own demographics | narrow allow-listed update | — | — | Unavailable |

## Report release control

- **Lab/imaging**: surfaced only when `status = VERIFIED` and `isCurrent = true`. Draft
  (`ENTERED`) and superseded versions never reach the patient.
- **Documents**: surfaced only when `accessPolicy = PATIENT_VISIBLE` and `status =
  CURRENT`. `CLINICAL_STAFF` and `RESTRICTED` documents are never exposed, even for the
  patient's own record.
- **Retrieval** re-verifies ownership + release + classification server-side and never
  exposes a raw storage URL (object storage is not configured; the authorized reference
  is returned, not a stream).

## DTO minimization & mass-assignment

- Every read maps to an explicit patient-safe DTO — internal IDs, audit metadata,
  internal notes, payer/system fields and authorization internals never leave the server.
- Every write uses a `.strict()` Zod schema and explicit field mapping. The profile
  update accepts only `preferredName`, `phone`, `address`, `language`,
  `communicationPreference`; `uhid`/`facilityId`/`sex`/`dob`/`registrationStatus`/`userId`
  and clinical/financial state are structurally unwritable by the patient.

## Money handling

Patient bills reflect the **hospital revenue cycle** (`Invoice`/`Payment`), distinct from
the D3/D5 SaaS commercial layer. Outstanding is the single authoritative computation
`totalMinor − allocatedMinor` (clamped ≥ 0); amounts are never summed across currencies
and are presented in whole rupees. A run-rate is never called "revenue".
