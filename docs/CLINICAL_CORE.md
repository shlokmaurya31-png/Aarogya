# Clinical Core — Phase 1: Unified Platform Foundation

This document records what Phase 1 actually built on top of Hospital OS's
existing Clinical Core (`docs/CORE_PLATFORM_ARCHITECTURE.md`), and — more
importantly — the specific places where the brief's idealized target model
(a renamed `Patient.legalName`, a single generic `ClinicalEvent` table, a
single generic `Order` table, a brand-new encounter-state vocabulary)
conflicted with the standing instruction **"do not rebuild what already
works."** Every deviation below is the actual reasoning behind a forward
reference left in code comments (`schema.prisma`, `encounterStateMachine.ts`,
`timeline.ts`, `audit.ts`, several API routes) pointing at this file.

The organizing principle, unchanged from the brief: **ONE PATIENT → ONE
LONGITUDINAL RECORD → MANY ENCOUNTERS → MANY CLINICAL EVENTS.** What
changed is *how* that principle is implemented — through services and
aggregators layered on the existing schema, not through a schema rewrite.

## §1. `Patient.fullName` was not renamed to `legalName`

The brief's target model names the primary identifier field `legalName`
(to make room for `preferredName` alongside it, which Phase 1 does add).
`fullName` was kept as-is. Renaming it would touch every route, seed
script, and UI component that already reads `patient.fullName` — a large,
purely cosmetic blast radius with zero functional benefit. `preferredName`
was added as a genuinely new, additive field instead. If a future phase
needs the `legalName` vocabulary specifically (e.g. for ABDM/insurance
integration that distinguishes legal vs. preferred name by contract), it
can be introduced as an aliasing read, not a rename.

## §2. `DepartmentMembership`, not a full multi-facility membership model

The brief's target identity model describes
`OrganizationMembership → FacilityMembership → DepartmentMembership` as
three separate scoped-membership layers. Phase 1 implements only the
narrowest slice actually needed: `DepartmentMembership`, which lets a
staff member (whose *primary* facility/department/role already lives on
`HospitalStaffProfile`) additionally hold standing in one more department
at the **same** facility — exactly the brief's own worked example ("Dr.
Sharma: one org, one facility, Cardiology + Emergency, two roles").

`OrganizationMembership` and `FacilityMembership` were **not** built,
because nothing in the current system needs a staff member to span two
facilities or two organizations yet — every hospital route already scopes
through a single `facilityId` derived from `HospitalStaffProfile`, and
building two more membership tables with no caller would be exactly the
"hundreds of meaningless permissions" anti-pattern the brief itself warns
against. Seeded proof this actually works: a Pune cardiologist holds a
second `DepartmentMembership` in Emergency (`prisma/seedData/hospitalPhase1.ts`).

## §3. Encounter states: reused the existing enum, added a real transition guard

The brief's target state list (`REGISTERED/CHECKED_IN/TRIAGED/WAITING/
IN_PROGRESS/ON_HOLD/ORDERS_PENDING/TREATMENT/DISPOSITION_PENDING/
COMPLETED/CANCELLED/CLOSED`) was **not** adopted. The existing
`EncounterStatus` enum (`REGISTERED/TRIAGED/IN_CONSULTATION/INVESTIGATING/
ADMITTED/DISCHARGED/CLOSED`) is real, tested, and load-bearing across
`admission.ts`, the orders routes, and the Doctor Workspace UI — renaming
it would break all of that for a purely cosmetic vocabulary match. `CANCELLED`
was added as the one genuinely missing state (an encounter that never
proceeds to treatment, e.g. a no-show, previously had no legal terminal
state other than forcing it through `DISCHARGED`).

What *was* missing, and what this phase actually built, is a **controlled
transition service** — `src/lib/hospital/encounterStateMachine.ts`. Before
this phase, `admission.ts` wrote `status: ADMITTED` unconditionally with
no prior-state check, and nothing prevented an illegal transition like
`CLOSED → IN_CONSULTATION`. The first draft of the allowed-transitions
table was written from the brief's idealized linear chain and immediately
proved too strict — it rejected `TRIAGED → INVESTIGATING` and direct
admission from `REGISTERED`/`TRIAGED`, both of which are real, already-working
call sites (`orders/lab/route.ts`, `orders/imaging/route.ts`,
`admission.ts`). The table was loosened to match actual working usage:

```
REGISTERED     → TRIAGED, IN_CONSULTATION, ADMITTED, CANCELLED
TRIAGED        → IN_CONSULTATION, INVESTIGATING, ADMITTED, DISCHARGED, CANCELLED
IN_CONSULTATION→ INVESTIGATING, ADMITTED, DISCHARGED, CANCELLED
INVESTIGATING  → IN_CONSULTATION, ADMITTED, DISCHARGED, CANCELLED
ADMITTED       → DISCHARGED
DISCHARGED     → CLOSED
CANCELLED      → CLOSED
CLOSED         → (terminal)
```

Live-verified this phase (not just unit-tested): `CLOSED → IN_PROGRESS`-style
resurrection is rejected end-to-end through the API
(`PATCH /api/hospital/encounters/[id]`, `POST .../cancel`), and an
`ADMITTED` encounter correctly rejects a subsequent cancel attempt
(`{"error":"Illegal encounter transition: ADMITTED -> CANCELLED"}` — a
discharge is the only legal path out of `ADMITTED`).

## §4. No generic `ClinicalEvent` table — computed aggregation instead

The brief's target model describes a single `ClinicalEvent` table where
"the event may represent an Observation/Diagnosis/Problem/Allergy/
Medication/Order/Result/Procedure/Note/Document/Referral/CarePlan/Task."
Phase 1 deliberately did **not** build this table. Every one of those
clinical facts already has its own well-typed, indexed table
(`Diagnosis`, `Problem`, `Allergy`, `Vital`, `MedicationOrder`, `ClinicalNote`,
etc.) — duplicating each row into a second generic table on write would
create two sources of truth that could drift, and would need to be kept
in sync by every write path forever.

Instead, `src/lib/patient/timeline.ts`'s `buildPatientTimeline()` queries
all of those tables at request time and merges them into one
chronologically-sorted view. This gets the brief's actual requirement
("a real Longitudinal Patient Timeline with clickable events linking to
source records") without the duplicated-write-path risk. The same
reasoning was applied to the generic `Task` table (§ below): tasks that
already have a natural home — medication-due, vitals-due — stay computed
views over `MedicationAdministration`/`Vital` rather than being
duplicated into `Task`; the `Task` table exists only for task types with
no natural home table (follow-ups, manual to-dos, referral-response
chasing).

Verified this phase: a patient's timeline correctly interleaves a `Task`,
a signed `ClinicalNote`, an `Allergy`, a `Diagnosis`, a `LabOrder`, and an
`Admission` in one chronological list, and correctly includes the history
of a patient that was later logically merged into another (via
`resolvePatientIdsForRead()`, see §7 below on merge — not a Scholar
concern, listed here for the timeline mechanism).

## §5. Diagnosis vs. Problem; the Referral lifecycle; note signing

**Diagnosis vs. Problem** are intentionally two different tables, matching
the brief's clinical distinction: `Diagnosis` is encounter-scoped and typed
(`PRIMARY/SECONDARY/PROVISIONAL/RULE_OUT/FINAL`), representing what a
specific encounter concluded; `Problem` persists across encounters,
representing the patient's ongoing problem list. Both were left with
free-text `codeSystem`/`code` fields (nullable) rather than a fake
ICD/SNOMED binding — real terminology binding is out of scope this phase
and a fabricated code system would be worse than none.

**Referral** is the one brand-new entity that adopted the brief's target
generalized order lifecycle verbatim
(`DRAFT/PLACED/ACKNOWLEDGED/IN_PROGRESS/COMPLETED/CANCELLED/REJECTED`) —
because it has no existing working code to break by doing so. The
existing order types (`MedicationOrder`, `LabOrder`, `ImagingOrder`) were
**not** migrated onto this vocabulary; they keep their own established,
tested, UI-integrated status strings. A full generalized `Order` table
unifying all order types is explicitly deferred (see Phase 2
prerequisites in the Phase 1 final report) — Phase 1 only needed the
foundational pattern proven once, on a new entity, not a risky migration
of working order types.

**Note signing**: `ClinicalNote.status` (`DRAFT/SIGNED/SUPERSEDED`) already
existed pre-Phase-1, but there was no way to sign an already-created
DRAFT note in place — `sign` was only settable at creation time. This was
a genuine gap against the brief's explicit requirement (§18, and manual
test item 13) and was fixed this phase: `PATCH /api/hospital/encounters/[id]/notes`
signs an existing `DRAFT` note (`DRAFT → SIGNED`, setting `signedAt`),
and rejects signing a note that is already `SIGNED` or `SUPERSEDED`
(`400`, verified live). A signed note is never mutated in place — an
amendment is always a new note with `supersedesId` pointing at the old
one, which flips to `SUPERSEDED`. Both the sign-then-reject-resign path
and the amend-via-`supersedesId` path were live-verified this phase.

## §6. Audit and the event-catalog naming

No new event-bus infrastructure was built this phase, deliberately (the
brief explicitly warns against building a large WebSocket/event-bus
foundation prematurely). Phase 1's ~17 new `AuditEventType` strings
(`hospital.patient.merged`, `hospital.diagnosis.added`,
`hospital.task.created`, etc.) are recorded through the existing
synchronous `recordAuditEvent()` helper, into the existing shared
`AuditEvent` table — but named to match the target event catalog in
`docs/EVENT_ARCHITECTURE.md` §4, so that a future real event bus can be
introduced by changing *how* these are dispatched, not *what* they are
named. `hospital.patient.viewed` additionally implements record-access
logging (metadata only — which patient, which view, by whom — never the
record payload itself), satisfying the brief's clinical-record-access
logging requirement without a new audit subsystem.

One real bug was found and fixed here during live verification: patient
merge's audit write originally happened in a separate `recordAuditEvent()`
call *after* the merge transaction had already committed, and passed a
`HospitalStaffProfile.id` where the `AuditEvent.userId` foreign key
expects a `User.id` — causing a foreign-key violation that surfaced to
the client as a 500 **even though the merge had already silently
succeeded**. Fixed by moving the audit write inside the same
`$transaction` as the merge itself (atomic: both commit or neither does)
and passing the correct `User.id`.

## §7. Patient self-service, and why Scholar stays out of this entirely

A new `Role.PATIENT` self-service surface was built this phase
(`/patient/login`, `/api/patient/register`, `/api/patient/me`,
`src/lib/auth/patientRbac.ts`'s `requirePatientSelf()`) — a patient's
`User` account links to exactly one `Patient` row (`Patient.userId`,
nullable unique), and `requirePatientSelf()` loads that row, rejecting
access if it has since been logically merged into another (`mergedIntoId`
set) rather than exposing a superseded record.

**This is entirely separate from Aarogya Scholar, by explicit instruction.**
Scholar's student/case/verification data model was not touched this
phase and has no relationship to `Patient`/`Encounter` at all. The brief
was explicit that hospital clinical data must never flow to Scholar
except through the existing Clinical Learning Data Gateway →
de-identification → Educational Case Snapshot pipeline
(`docs/CLINICAL_EDUCATION_PRIVACY.md`), and that boundary was not crossed
or weakened this phase — confirmed by live regression testing (see the
Phase 1 final report's Security Test Results): a student session cannot
read `/api/hospital/patients/*` (`403`, permission-based, same as before
this phase), and the Scholar dashboard/case-list/case-of-the-day flow for
an existing verified student account works unchanged.

## §8. Document and Consent: metadata foundations, not full subsystems

`ClinicalDocument` is a metadata-only foundation (`storageRef` nullable —
no file storage/upload pipeline was built this phase; this table records
*that* a document exists and its type/patient/encounter linkage, not the
bytes). A real document-management system (versioning, virus scanning,
signed URLs) is out of scope, consistent with the brief's explicit
"foundation, not a full DMS" instruction.

`Consent` is a first-class non-boolean record
(`REQUESTED/GRANTED/DENIED/REVOKED/EXPIRED`), replacing what would
otherwise be an implicit boolean somewhere. No workflow this phase
*gates* on consent status (the brief explicitly scoped this as
"foundation" work) — the table and its revoke endpoint
(`PATCH /api/hospital/consents/[id]`) exist so a future phase can wire
gating logic against real data rather than retrofitting a schema change.

## §9. What Phase 1 intentionally left out of every foundation above

Per the brief's explicit "Phase 1 only needs the foundational
architecture" instruction, repeated for orders, tasks, documents, and
consent specifically: no complete LIS/RIS/pharmacy workflow, no real
queueing/worklist beyond what already existed pre-Phase-1, no consent
enforcement gating, no document storage backend, no generalized `Order`
table unifying medication/lab/imaging/referral. These are named as Phase
2 prerequisites in the Phase 1 final report, not silently dropped.

## Cross-reference: where the target model's abstractions actually live today

| Brief's target concept | Phase 1 reality |
|---|---|
| `ClinicalEvent` (generic) | Computed aggregation in `timeline.ts` — see §4 |
| `Order` (generic) | Not built; `Referral` proves the pattern once — see §5 |
| Renamed encounter states | Not adopted; existing enum + new transition service — see §3 |
| `OrganizationMembership`/`FacilityMembership` | Not built; only `DepartmentMembership` exists — see §2 |
| `Patient.legalName` | Not adopted; `fullName` kept, `preferredName` added — see §1 |
| Hospital → Scholar clinical data flow | Still architecture-only (gateway), not built this phase — see §7 |
