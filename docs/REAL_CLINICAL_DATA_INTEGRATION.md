# Real Clinical Data Integration — Architecture Only

**This document describes an architecture that does not exist in this
repository.** No code here connects to a real EHR, hospital system, or lab.
`CLINICAL_DATA_MODE=synthetic` is the only implemented mode
(`src/lib/clinical/config.ts`). This document exists so that *if* Aarogya
ever integrates real, authorized clinical data into Scholar's case library,
the shape of the work is already reasoned about — it is not a claim that
this integration is planned, funded, or imminent.

## Pipeline

```
Hospital / EHR system
   |
   v
Approved extraction (institution-controlled, not Aarogya-controlled)
   |
   v
Consent / legal basis / institutional policy check
   |
   v
Data minimization (pull only fields the educational use case needs)
   |
   v
De-identification (src/lib/privacy/*, see docs/CLINICAL_EDUCATION_PRIVACY.md)
   |
   v
Privacy risk review (independent of the extraction team)
   |
   v
Educational transformation (caseSanitizer.ts -> EducationalCaseSnapshot)
   |
   v
Isolated learning database (this application's ClinicalCase table)
   |
   v
Student access (via ClinicalCaseProvider, permission-gated)
```

## What a real provider implementation needs

A `DeidentifiedClinicalFeedProvider` (or `InstitutionCaseProvider`) that
actually connects to something would need, at minimum:

1. **Its own credentials and network boundary** — never the same database
   connection/credentials as the education platform. The education
   platform should have *no* network path to the source clinical system at
   all; only the gateway's extraction/transformation job does.
2. **A governance/consent check performed before extraction**, not after —
   the diagram's "Consent / authorization / governance layer" box is not
   optional and not retrofittable after the fact.
3. **An implementation of `sanitizeToEducationalCase()`'s contract** — the
   provider's output must be an `EducationalCaseSnapshot`, checked by
   `checkNoProhibitedIdentifiers()`, exactly like every synthetic case is
   today (see `prisma/seedData/builder.ts`'s call to
   `assertSyntheticCaseIsClean()` — a real provider needs the equivalent
   check on its own output, not a shortcut around it).
4. **Human review before publish** — automated de-identification is not
   sufficient on its own for real patient data; a person independent of the
   extraction pipeline should review each case (or a statistically
   meaningful sample, for high-volume feeds) before it's marked
   `isPublished: true`.

## Revocation

If source consent is withdrawn, or an institution requests removal, the
corresponding `ClinicalCase` row(s) must be identifiable and removable. The
mapping from `ClinicalCase.id` to a source record must NOT live in this
application's database (see `docs/CLINICAL_EDUCATION_PRIVACY.md` §8) — it
belongs in the privileged extraction/gateway system, which is the only
system with both source and educational identifiers in scope. On
revocation: the case is unpublished/deleted from `ClinicalCase`, and any
`CaseAttempt`/`CaseAction` rows referencing it are handled per the
institution's data-retention agreement (this repository does not define
that policy — it is an institutional/legal decision, not an engineering
default).

## Retention

- Source clinical data: never stored by the education platform in the
  first place — retention is governed entirely by the source system.
- Verification documents: see `docs/CLINICAL_EDUCATION_PRIVACY.md` §4.
- Case attempt data (`CaseAttempt`, `CaseAction`): educational records about
  the *student's* performance, not about any patient — ordinary application
  data retention policy applies, no different from any other LMS-style
  system.

## Data lineage

A real integration needs an explicit lineage record (source record ID ->
educational case ID) for audit and revocation — but per the core principle
in `docs/CLINICAL_EDUCATION_PRIVACY.md` §8, **that lineage record cannot
live in a system students, educators, or even Aarogya application code can
query**. It belongs in a separate, access-controlled system operated by
whoever runs the extraction pipeline, queryable only by governance/audit
roles with a documented need.

## Auditing & incident response

Beyond the `AuditEvent` table already logging Scholar-side actions (case
opens, submissions, verification decisions — see
`docs/CLINICAL_EDUCATION_PRIVACY.md` §5), a real integration needs:

- Access logging on the *source* side (who extracted what, when, under
  what authorization) — outside this application's scope, owned by
  whoever runs the extraction pipeline.
- A documented incident-response process for the specific failure mode of
  "an educational case turns out to contain an identifiable detail" —
  including who is notified, how affected cases are pulled, and how
  affected students' access history to that case is reviewed.

## Explicitly not addressed here

- Which specific legal framework applies (DPDP, institutional IRB-equivalent
  processes, or others) — this is a legal question for Aarogya's counsel
  and each partner institution, not an engineering decision.
- Whether any given institution's data-sharing agreement permits
  educational reuse at all — a prerequisite this document assumes is
  answered *before* any of the above pipeline is built, not something the
  pipeline itself resolves.
