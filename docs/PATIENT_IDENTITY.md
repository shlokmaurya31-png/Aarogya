# Patient Identity & Account Linking (D11)

Patient identity is D11's first security boundary. A patient is **never** identified by
a `patientId` in a URL or body — only by an authenticated session resolved to a
canonical `Patient` through `src/lib/patient/context.ts`.

## The chain

```
User (role = PATIENT)
  ↓ Patient.userId  (unique — one account ↔ one patient identity)
Patient
  ↓ mergedInto / resolvePatientIdsForRead  (EMPI merge chain, non-destructive)
Longitudinal record  (all canonical clinical/financial/interop tables)
```

- **Account creation ≠ patient record creation.** `POST /api/patient/register` creates a
  `User` and links a `Patient` (existing route, unchanged). A patient account maps to a
  patient identity via `Patient.userId`; it does not fork a duplicate record.
- **EMPI reuse.** Reads are merge-aware: `resolvePatientIdsForRead(patientId)` returns
  the patient plus any records merged INTO them, so a merged history is presented as one
  record. Merges remain a canonical, non-destructive, staff-governed operation — D11
  never merges patients and never lets a patient select another patient's record.
- **Superseded records.** A merged (superseded) own-record does not present as live; the
  context resolver treats it as if the caller has no self record (matching
  `requirePatientSelf`).

## Access resolution

`requirePatientContext()` establishes: authenticated + non-revoked session, PATIENT
role, and the caller's own `selfPatientId` (or `null` for a pure caregiver).

`resolveReadScope(ctx, requestedPatientId?)`:
- no `requestedPatientId` → the caller's own record;
- a `requestedPatientId` → honored **only** if it is in the caller's accessible set
  (self + ACTIVE, unexpired delegations); otherwise 404-shaped.

`resolveActScope(ctx, requestedPatientId?)` → same, but **self only**. A delegate can
never act.

## Why a delegate may hold no self patient

A pure caregiver may have a `User` account but no `Patient` of their own. The context
handles `selfPatientId = null` gracefully: they can still hold and use delegated access,
but have no self record to read or act on.

## What D11 did NOT change

- No second authentication stack — the existing HMAC session is reused.
- No duplicate patient store — `PatientDelegation` is the only new table, and it holds
  access grants, not clinical data.
- No patient-driven identity mutation — a patient can edit only contact/communication
  preferences (see PATIENT_DATA_ACCESS §profile), never `uhid`, `facilityId`, `sex`,
  `dob`, `registrationStatus`, `userId`, or merge state.
