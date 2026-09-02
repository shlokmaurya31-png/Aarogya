# Clinical Education Privacy — Aarogya Scholar

This document explains how student-facing educational cases are kept
isolated from any real clinical source, how student verification data is
handled, and what governance a real deployment still needs. **It does not
claim compliance with any specific law or certification** (not DPDP, not
NDHM/ABDM) — see §8.

## 1. Data flow

```
Clinical System (future — does not exist in this repository)
   |
   v
Consent / authorization / governance layer   (future — not implemented)
   |
   v
Clinical Learning Data Gateway                 src/lib/clinical/gateway.ts
   |
   v
De-identification + minimization               src/lib/privacy/*
   |
   v
Educational Case Snapshot                       ClinicalCase (Prisma model)
   |
   v
Student Case Engine                             src/lib/caseEngine/*
```

Today, only the bottom half of this diagram is real: `SyntheticCaseProvider`
reads `ClinicalCase` rows seeded by `prisma/seed.ts` from fictional case
definitions (`prisma/seedData/cases/*.ts`). No code path connects to, or
even references, a real clinical database. `CLINICAL_DATA_MODE` has exactly
one implemented value (`synthetic`); see `src/lib/clinical/config.ts`.

## 2. Source isolation

- `getActiveCaseProvider()` (`src/lib/clinical/gateway.ts`) is the *only*
  way case data reaches the case engine. There is no other query path.
- The `ClinicalCaseProvider` interface (`src/lib/clinical/provider.ts`) is
  implemented today only by `SyntheticCaseProvider`.
  `DeidentifiedClinicalFeedProvider`, `HistoricalTeachingCaseProvider`, and
  `InstitutionCaseProvider` (`src/lib/clinical/providers/futureProviders.ts`)
  are typed stubs that throw `NotImplementedProviderError` — they exist so
  the *interface* is reviewable, not so a future engineer can flip a switch
  without writing real code and going through the governance process in
  `docs/REAL_CLINICAL_DATA_INTEGRATION.md`.

## 3. De-identification (for any future real-source case)

`src/lib/privacy/` implements the pipeline a real-source case would have to
pass through before becoming an `EducationalCaseSnapshot`:

| Module | Responsibility |
|---|---|
| `deidentify.ts` | Strips/generalizes direct identifiers (name, patient ID, Aadhaar, ABHA, phone, email, address, facility name, room/bed) from a raw record shape. |
| `educationalIdentity.ts` | Generates a case-local synthetic name, deterministically keyed to the case id — **not derived from or reversible to** any source identity. Also provides age-banding (`ageToBand`). |
| `dateShift.ts` | Shifts every date on a case by the same case-specific offset, preserving clinically relevant intervals (onset → admission → discharge) while hiding the real calendar date. |
| `redaction.ts` | Pattern-based scrubbing of free text (phone/email/Aadhaar/ABHA/MRN/URL shapes). |
| `privacyPolicy.ts` | `checkNoProhibitedIdentifiers()` — a structural assertion pass that recursively scans an object for field *names* on a prohibited list. |
| `caseSanitizer.ts` | `sanitizeToEducationalCase()` — the single choke point a real-data pipeline would call, composing the above and re-asserting the policy check on the output. |

Even though no real data flows through this pipeline today, it is exercised
by the educator-authoring endpoint (redaction pass on free text, see threat
model T-11) and has unit test coverage (`src/lib/privacy/*.test.ts`) so it
is proven correct *before* it is ever pointed at anything sensitive.

Age handling: `ageToBand()` generalizes to a 5-year band by default;
`exactAgeIfClinicallyRequired` is only populated when a case explicitly
opts in (e.g. pediatric weight-based dosing calculations), never as a
default.

Rare diseases: `DeidentifiedRecord.strongerPrivacyControls` is set from a
`rareDiseaseFlag` on the source record — a real pipeline should route these
cases through additional manual review before publication, given the
higher re-identification risk of rare presentations.

## 4. Verification-document handling

Student ID cards / enrollment letters are handled by
`VerificationProvider` (`src/lib/verification/provider.ts`):

- `MockVerificationProvider` (the only implementation wired up) writes to
  `.data/verification-uploads/` — outside `public/`, outside `src/app`, and
  gitignored. No route serves this directory.
- The database (`VerificationDocument`) stores only a `storageRef` (file
  path) and a `sha256` hash — never raw bytes, and never joined into a
  student's own profile response or any other student's view.
- Documents are never sent to the AI provider, never included in any prompt,
  and never used as case content.
- `ManualVerificationProviderStub` documents (without implementing) what a
  real secure-storage adapter (S3 + KMS, access-logged retrieval, retention
  policy) would need to replace the mock with.

**Retention**: not implemented in this pass — a production deployment needs
an explicit retention/deletion policy for verification documents (e.g.
delete N days after verification decision, per the brief's "be deletable
after verification where appropriate").

## 5. Audit

`AuditEvent` (Prisma model) + `recordAuditEvent()`
(`src/lib/auth/audit.ts`) log security-relevant actions:
`student.verification.submitted/approved/rejected`, `student.case.opened/
action/submitted`, `educator.case.created`, `admin.verification.reviewed`.
Events store `type`, `userId`, a JSON `detail` blob, and a timestamp — never
verification-document bytes or case answer keys.

For a real clinical-source integration, auditing must be materially
stricter (source-record access logging, data-lineage tracking from source
record to educational case, and incident-response tooling) — see
`docs/REAL_CLINICAL_DATA_INTEGRATION.md` §"Auditing & incident response".

## 6. Synthetic development mode

`CLINICAL_DATA_MODE=synthetic` is both the default and, in this build, the
*only* implemented value. There is no environment-variable path to a real
feed — see `src/lib/clinical/config.ts`. This is a deliberate fail-closed
design: a typo in the env var throws at boot rather than silently
continuing to serve whatever was already configured.

## 7. Future governance requirements

Before any real clinical-source data feeds this pipeline, a deployment
needs (not built here — see `docs/REAL_CLINICAL_DATA_INTEGRATION.md`):

- A documented legal basis / institutional consent for educational reuse.
- Purpose limitation: source data usable only for the declared educational
  purpose, not silently repurposed.
- Data minimization review of exactly which fields cross the gateway.
- A privacy/security review of the de-identification pipeline's output by
  someone independent of the engineering team that built it.
- A revocation mechanism: if a source patient (or institution) withdraws
  consent, the corresponding educational case(s) must be identifiable and
  removable — which requires the gateway to keep *some* lineage record, but
  that record must live in a privileged system the education platform
  cannot query (see §8's core principle).

## 8. Core principle: Student Case ID ≠ Clinical Patient ID

Even in a future state where cases are derived from authorized real
clinical data, **a student has no mechanism to reverse an educational case
back to a source patient**. `EducationalCaseSnapshot` (produced by
`caseSanitizer.ts`) carries a `caseId`, never a source patient identifier.
If a mapping from educational case to source patient must exist at all (for
audit/revocation purposes), it belongs in a privileged integration
environment that Aarogya Scholar cannot query — not in this application's
database, and not in any table a `STUDENT` or `EDUCATOR` role can read.

## 9. What this document does not claim

This is an engineering description of what the code does, not a compliance
certification. In particular, this repository does **not** claim to be
DPDP-compliant, NDHM-certified, or ABDM-certified. Any real deployment
handling actual clinical records requires legal, institutional, and
information-security review beyond what is described here — see
`docs/REAL_CLINICAL_DATA_INTEGRATION.md`.
