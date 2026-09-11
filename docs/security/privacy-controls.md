# Privacy Controls

> **Scope note.** These are *technical controls that support* privacy and
> data-protection requirements. This is not a compliance claim, not a
> certification, and not legal advice. In particular nothing here asserts DPDP
> compliance — implementing controls is not the same as being compliant.

## Data classification

`STANDARD_CLINICAL` · `SENSITIVE_CLINICAL` · `HIGHLY_SENSITIVE` · `FINANCIAL` ·
`IDENTITY` · `SECURITY`

Applied at resource/action level. No new column was added:
`ClinicalDocument.accessPolicy` already carries the distinction, and a second
sensitivity field would compete with it as a source of truth.

## Restricted documents

`RESTRICTED` documents now require a `DIRECT_CARE` relationship, closing the C1
gap where they were returned to any facility staff member holding
`patient:read`.

Restricted documents are **withheld, not errored**: the caller still receives the
unrestricted list plus a `restrictedWithheld` count, so the UI can say "2
restricted documents were withheld". Silently showing a shorter list would be its
own safety problem.

## Patient access

A `PATIENT` session is confined to its own record. The patient id is resolved
from the **session** (`resolveSelfPatient`), never from a query parameter —
which is exactly the IDOR this would otherwise introduce.

`PATIENT_SELF` is its own relationship axis: no staff relationship satisfies a
self policy, and being the patient does not make you staff.

A merged (superseded) patient record never presents itself as live.

## Privacy requests

`ACCESS` · `CORRECTION` · `RESTRICTION` · `WITHDRAW_CONSENT` ·
`DELETION_REQUEST`

Workflow: `REQUESTED` → `UNDER_REVIEW` → `APPROVED`/`REJECTED` → `ACTIONED`, or
`CANCELLED`. Approval cannot skip review, rejection is terminal, and only an
approved request can be actioned. A decision requires a recorded rationale.

### Deletion is a REQUEST, not an instruction

**Nothing in this workflow deletes a clinical record.**

Clinical notes, diagnoses, results, medication administration, operative notes,
transfusion records and audit events carry retention and safety obligations that
a generic workflow has no business overriding. A system that silently honoured a
deletion request would be dangerous.

The terminal state is a recorded **decision**. Any resulting action is a
separate, deliberate operation outside this workflow. The security gate asserts
that a deletion request leaves the clinical record count unchanged.

### Legal hold

`legalHold` blocks actioning outright, whatever the decision was. Setting a hold
requires a reason.

## Retention

`describeRetention()` reports retention metadata and, prominently,
`automatedDeletion: false`.

**Aarogya runs no cleanup job and purges no clinical, financial or audit
record.** The policies are descriptive. Exposing them without wiring them to a
deleter is the deliberate choice — the alternative is a background task capable
of destroying medical records.

Audit events are append-only and are never deleted by this system.

## Data minimisation

FHIR export composes only the consented scopes. `RESTRICTED` documents are
excluded from bulk export entirely; releasing one is a separate deliberate
decision. Internal operational fields, permissions and security metadata are not
mapped into any outbound representation.

C1's rule holds: `ALL_CLINICAL` does **not** imply `BILLING`. Financial
disclosure is a separate consent decision.

## Audit access

Audit is itself sensitive. `audit.read.facility` is facility-scoped and requires
hospital administration; `audit.read.platform` is cross-facility and additionally
requires step-up. A clinician reading a chart does not thereby see who was denied
access to whom.

Security events live in a separate `security.*` namespace precisely so this
boundary can exist.
