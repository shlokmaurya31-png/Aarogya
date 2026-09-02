# Data Model Audit — Phase 0 (see addendum below for Phase 1 changes)

Audit of `prisma/schema.prisma` as it exists today: **40 models, 15 enums,
946 lines**, single SQLite datasource shared by Scholar and Hospital OS.
The original Patient/Doctor/Hospital prototype has **zero** database
presence — every model below is exclusively Scholar's or Hospital OS's.

> **Phase 1 addendum**: the schema has since grown to include
> `DepartmentMembership`, `EpisodeOfCare`, `Diagnosis`, `Task`,
> `ClinicalDocument`, `Consent`, `Referral`, and `PatientMergeRecord`, plus
> extensions to `Patient`, `PatientIdentifier`, `Allergy`, and `Encounter`.
> The original Phase 0 audit text below is left unchanged as a historical
> record of what existed before Phase 1; see the addendum at the bottom of
> this file (§10) for what changed and why, and `docs/CLINICAL_CORE.md`
> for the full reasoning behind each addition.

## 1. Identity core

### `User`
- Owner: shared (Scholar + Hospital OS).
- Fields: `email` (unique), `passwordHash` (scrypt, `salt:hash` hex),
  `role` (`Role` enum), `displayName`.
- Relations: `studentProfile?`, `hospitalStaffProfile?`, `authoredCases[]`,
  `caseAttempts[]`, `notebookEntries[]`, `achievements[]`,
  `auditEvents[]`, `competencies[]`, `cohortMemberships[]`,
  `submissions[]`.
- Tenant relationship: **none directly** — tenancy is derived transitively
  through `hospitalStaffProfile.facilityId` for hospital roles, or through
  `studentProfile.institutionId` for Scholar roles. A `User` row itself
  is global (not facility- or institution-scoped), which is correct for a
  single sign-on identity but means nothing on `User` itself prevents a
  role mismatch bug from granting cross-tenant access if a future route
  forgets to join through the profile.
- Indexes: `@@index([role])`. **Missing**: no index on anything supporting
  "list all users at facility X" — that query always goes through
  `HospitalStaffProfile.facilityId` instead, which does have `@@index`.
- Audit fields: `createdAt`, `updatedAt`. No `deletedAt`/soft-delete.
- Lifecycle/status: none on `User` itself — active/inactive is tracked on
  `HospitalStaffProfile.status` (hospital) and implicitly via
  `StudentProfile.verificationStatus` (Scholar). **Gap**: a Scholar
  `EDUCATOR`/`INSTITUTION_ADMIN` account has no explicit active/suspended
  status field at all.

### `Role` (enum)
`PATIENT, DOCTOR, STUDENT, EDUCATOR, INSTITUTION_ADMIN, AAROGYA_ADMIN,
HOSPITAL_ADMIN, NURSE, LAB_TECHNICIAN, RADIOLOGY_TECH, PHARMACIST,
BILLING_STAFF`. `PATIENT` and `DOCTOR` exist in the enum but are **not
backed by any real feature** — `PATIENT` has zero permissions granted in
`permissions.ts` and no route checks for it; `DOCTOR` was seeded once as a
placeholder (`doctor@demo.aarogya`) before Hospital OS gave it a real
purpose. This is intentional scaffolding for the eventual Patient/Doctor
migration (see `docs/AAROGYA_TARGET_ARCHITECTURE.md`), not dead code to
delete — but it means "does this role do anything" cannot be answered by
the enum alone; `src/lib/auth/permissions.ts` is the source of truth.

## 2. Hospital OS tenancy chain

```
Organization (1) → Facility (N) → Department (N) → Ward (N) → Bed (N)
```

- `Organization`: `name` only beyond id/timestamps. **Gap**: no billing
  plan, no org-level settings — appropriate for Phase 1, a real gap for
  the SaaS/licensing phase (§17 of the original brief, Phase 10).
- `Facility`: owns `departments[]`, `wards[]`, `beds[]`, `staff[]`,
  `patients[]`, `encounters[]`, `charges[]`, `bills[]` — this is the
  actual tenant-isolation boundary; every hospital-domain query in
  `src/app/api/hospital/*` filters by `facilityId` derived from
  `requireFacilityStaff()`. **This is correctly the single foreign key
  that matters for tenant isolation** — see `docs/SECURITY_AUDIT.md` S-05
  for what's verified vs. assumed.
- `Department`: `@@unique([facilityId, name])` — correct, prevents
  duplicate department names within one facility, allows the same name
  across facilities.
- `Ward`: `@@unique([facilityId, name])`, `wardType` enum (`GENERAL, ICU,
  HDU, NICU, PICU, EMERGENCY, PRIVATE, SEMI_PRIVATE, ISOLATION,
  OT_RECOVERY`). Optional `departmentId` — a ward need not belong to a
  department (matches reality: ICU often isn't "owned" by one department).
- `Bed`: `@@unique([facilityId, label])`, `status` (`BedStatus` enum),
  `genderRestriction` (nullable string — **not an enum**, a real gap: `"male"`/`"female"`
  are free-text convention only, not schema-enforced), `isolationRequired`
  boolean. `@@index([status])` — supports the Command Center's
  group-by-status query well.
- **Missing entity**: `Room` — the brief's target hierarchy (§6 of the
  Phase 0 instructions) wants `Ward → Room → Bed`; the current schema has
  `Ward → Bed` directly, no `Room` grouping. Not a blocker (a `Bed.label`
  like `"EB-1"` can encode a room informally), but a real gap for physical
  facility mapping — see `docs/TARGET_DOMAIN_ARCHITECTURE.md`.

### `BedStateEvent`
- Append-only audit trail for every bed transition: `fromStatus`,
  `toStatus`, `reason`, `patientId`/`encounterId` (both **plain string
  fields, not foreign keys** — see gap below), `byUserId`, `createdAt`.
  `@@index([bedId])`.
- **Data-integrity gap**: `patientId`, `encounterId`, and `byUserId` on
  `BedStateEvent` are unconstrained strings, not `@relation` foreign keys.
  This was a deliberate simplification (avoids requiring every bed event
  to resolve a live patient/encounter, e.g. for pre-admission reservation
  reasons) but means the database cannot guarantee these IDs are valid —
  a typo or a deleted row leaves a dangling reference with no constraint
  violation. Low risk today (nothing deletes `Patient`/`Encounter` rows),
  real risk if a future "purge old records" feature is added without
  fixing this first.

## 3. Hospital OS staff

### `HospitalStaffProfile`
- `userId` unique (1:1 with `User`), `facilityId` (required),
  `departmentId?`, `displayRole` (free-text label, not an enum —
  intentional: "Cardiologist" vs "ICU Nurse" vs "Lab Technician" don't
  need to be a closed set for display purposes, but this means there's no
  schema-level list of valid job titles), `employeeId?`, `specialty?`,
  `licenseNumber?`, `licenseExpiry?`, `status` (`ACTIVE/INACTIVE/
  SUSPENDED`). `@@index([facilityId])`.
- **Gap**: `licenseExpiry` is captured but nothing reads it — there is no
  alert/check for expiring credentials (brief's §56 "Credentialing" —
  explicitly out of scope this phase, field exists for forward
  compatibility only).
- Relations back to almost every clinical action as an "ordered by" /
  "authored by" / "administered by" foreign key — this is correct and is
  what makes every clinical action attributable to a real staff member
  (never just a `User.id`, always resolved through their facility-scoped
  profile).

## 4. Patient + longitudinal record (Hospital OS)

### `Patient`
- `uhid` unique (format `UHID-<facility-code>-<random>`, generated in
  `src/app/api/hospital/patients/route.ts`), `facilityId` (required —
  **a patient belongs to exactly one facility today**, a real
  simplification flagged in the architecture doc: a multi-facility group
  where the same person is seen at two hospitals would currently create
  two unrelated `Patient` rows with no linkage). `sex` free-text (not
  enum). `dob?`/`ageYears?` — both nullable, no constraint that at least
  one is present, no validation that they agree if both are.
- Relations: `identifiers[]`, `allergies[]`, `problems[]`, `encounters[]`,
  `medicationOrders[]`, `labOrders[]`, `imagingOrders[]`, `charges[]`,
  `bills[]`. `@@index([facilityId])`.
- **Missing entity relative to the target model**: no `EpisodeOfCare`
  grouping multiple related `Encounter`s (e.g. an OPD visit that leads to
  an ED visit that leads to an IPD admission for the same problem) — see
  `docs/TARGET_DOMAIN_ARCHITECTURE.md` §2.

### `PatientIdentifier`
- `type` free-text (`"ABHA" | "INSURANCE_MEMBER_ID" | "EXTERNAL_MRN"` by
  convention, not enum-enforced), `value`. `@@index([patientId])`. No
  `@@unique([type, value])` — two patients could accidentally be given the
  same external identifier with no constraint violation. Real gap for
  ABHA-linkage correctness once that integration exists.

### `Allergy`
- `substance`, `reaction?`, `severity` (free-text `"mild"|"moderate"|
  "severe"`, not enum). `@@index([patientId])`. This is the table
  `clinicalSafety.ts` reads for the medication-order allergy check — see
  `docs/CLINICAL_SAFETY_AUDIT.md`.

### `Encounter`
- `type` (`EncounterType`: OPD/ED/IPD/DAYCARE/TELEMEDICINE), `status`
  (`EncounterStatus`: REGISTERED/TRIAGED/IN_CONSULTATION/INVESTIGATING/
  ADMITTED/DISCHARGED/CLOSED), `chiefComplaint?`, `triageLevel?` (raw
  `Int`, 1–5, **not range-constrained at the schema level** — application
  code checks 1–5 in the triage route but the DB would accept any int),
  `attendingStaffId?`. `@@index([facilityId])`, `@@index([status])`,
  `@@index([patientId])`.
- This is correctly the hub of the longitudinal record — `ClinicalNote`,
  `Vital`, `MedicationOrder`, `LabOrder`, `ImagingOrder`, `Charge` all key
  off `encounterId`, and the patient chart API
  (`/api/hospital/patients/[id]/chart`) queries all of them across every
  encounter for that patient — this is the one place in the codebase that
  actually implements "unified patient record across visit types" (brief
  §69), not per-encounter silos.

### `Admission` / `Transfer` / `Discharge`
- `Admission.encounterId` unique (1:1 — an encounter has at most one
  admission, correct for the current single-admission-per-encounter
  model; a re-admission is a new `Encounter`). `bedId`, `reason`,
  `expectedLosDays?`, `admittingStaffId`.
- `Transfer`: `fromBedId`/`toBedId` (two separate relations to `Bed`,
  named `TransferFromBed`/`TransferToBed`), `reason`, `byUserId` (plain
  string, not FK — same pattern/gap as `BedStateEvent`).
- `Discharge.admissionId` unique (1:1), six boolean readiness flags
  (`clinicallyReady, documentationReady, billingReady, insuranceReady,
  pharmacyReady, transportReady`), `dischargeSummary` (`Json?`),
  `signedByStaffId?` (plain string, not FK). `dischargedAt?` null until
  finalized.
- **Gap**: `signedByStaffId` should be a proper relation to
  `HospitalStaffProfile` for referential integrity and to support "list
  all discharges signed by Dr. X" without string matching. Currently a
  bare string (actually the raw `User.id` from the session, not even the
  staff profile id — an inconsistency with the `*StaffId` naming
  convention used everywhere else in the schema).

### `ClinicalNote`
- `type` free-text, `content` (`Json` — structured per note type, e.g.
  `{assessment, plan}` for progress notes), `status` (`"DRAFT"|"SIGNED"|
  "AMENDED"|"SUPERSEDED"`, free-text not enum), `supersedesId?` (plain
  string, not FK — self-referential amendment chain is not
  database-enforced). `signedAt?`.
- Correctly implements "never silently mutate a signed note" (brief §16/
  §185) at the *application* layer (`encounters/[id]/notes/route.ts`
  flips the old note to `SUPERSEDED` rather than editing it) — but this
  discipline is not enforced by the schema; a direct DB write could still
  mutate a `SIGNED` note's `content`.

### `Problem`
- `diagnosis` free-text (**no terminology binding** — see
  `docs/TARGET_DOMAIN_ARCHITECTURE.md` and the brief's ICD/SNOMED note;
  this is architecture-only today, correctly not faked with a fake code
  system), `status` free-text, `severity?`, `onsetDate?`.

### `Vital`
- `hr/sbp/dbp/rr/spo2` (`Int?`), `tempC` (`Float?`), `painScore` (`Int?`),
  `recordedByStaffId` (plain string, not FK — same gap pattern),
  `recordedAt`. No range/plausibility constraints (a `spo2` of 250 would
  be accepted) — appropriate for Phase 1 (validation belongs in
  application code, not necessarily the schema), flagged as a gap for
  when real clinical data quality matters more.

## 5. Orders (Hospital OS)

`MedicationOrder`, `LabOrder`, `ImagingOrder` all follow the same shape:
`encounterId` + `patientId` (both present — a deliberate denormalization
so patient-scoped queries, e.g. the chart API, don't need to join through
`Encounter` every time), `orderedByStaffId`, `status` (free-text per
model, not a shared enum — `MedicationOrder.status` values differ from
`LabOrder.status` values, which is correct since their lifecycles differ,
but means there's no single "OrderStatus" enum reused across order types).

- `MedicationOrder.safetyFlags` (`Json?`) + `overrideReason?` — see
  `docs/CLINICAL_SAFETY_AUDIT.md` for the full analysis of what this
  captures and doesn't.
- `MedicationAdministration`: `medicationOrderId`, `administeredByStaffId?`
  (nullable — a scheduled-but-not-yet-given dose has no administerer
  yet), `scheduledAt`, `administeredAt?`, `status` (`DUE/GIVEN/HELD/
  MISSED`). **Gap**: nothing currently transitions a `DUE` row to
  `MISSED` automatically when `scheduledAt` passes — the Nursing task
  engine (`/api/hospital/nurse/tasks`) surfaces overdue-looking items by
  querying `scheduledAt <= now AND status = DUE`, but the row's `status`
  field itself stays `DUE` forever until a human acts. A background job
  or a computed-at-read-time status would close this gap.
- `LabResult`/`ImagingReport`: 1:1 with their order (`@unique` on the FK),
  `isCritical` boolean, `acknowledgedAt?`/`verifiedAt?` — this is the
  field the alert engine polls for "unacknowledged critical result."
  **No escalation timestamp/chain** — if unacknowledged for days, the
  alert engine's message just says how long, but there's no schema
  support for "this was escalated to the department head at T+2h."

## 6. Billing (Hospital OS)

- `Charge`: `encounterId`, `patientId`, `facilityId` (triple
  denormalization — all three present even though `patientId`/`facilityId`
  are derivable from `encounterId`; deliberate for query simplicity,
  consistent with the pattern in §5), `category` free-text, `amount`
  (`Float` — **not a `Decimal`**, a real gap for money: floating-point
  currency arithmetic can accumulate rounding error; low risk at current
  scale/precision needs, a real fix needed before production billing).
  `sourceType?`/`sourceId?` (both plain strings — loosely-typed polymorphic
  reference to "what generated this charge," not a real polymorphic
  relation).
- `Bill`: `encounterId` unique (one bill per encounter — no support today
  for one consolidated bill across a multi-encounter episode of care, see
  `docs/TARGET_DOMAIN_ARCHITECTURE.md`'s `EpisodeOfCare` gap), `totalAmount`
  (`Float`, same rounding concern), `paidAmount` (`Float`, default 0 —
  **nothing currently writes to this field**; there is no payment-recording
  route yet), `status` free-text default `"OPEN"`.

## 7. Scholar models (unchanged this phase, summarized for completeness)

`Institution, InstitutionDomain, Cohort, CohortMembership, StudentProfile,
VerificationDocument, ClinicalCase, CaseAttempt, CaseAction,
StudentCompetency, Achievement, StudentAchievement, NotebookEntry,
LearningRecommendation, Assignment, AssignmentSubmission`. Full detail in
`docs/STUDENT_PLATFORM_ARCHITECTURE.md` §2.9 — not re-audited here since
nothing in this schema section changed this session; one runtime gap was
found and fixed (see `docs/SECURITY_AUDIT.md` S-06,
`syntheticCaseProvider.ts` `getCaseFull` `isPublished` filter).

## 8. Shared audit

### `AuditEvent`
- `type` (free-text string, not enum — deliberately open so both Scholar
  and Hospital OS can add new event type strings without a schema
  migration; the price is no schema-level guarantee of what values exist,
  only the TypeScript union in `src/lib/auth/audit.ts`), `userId?`,
  `detail?` (`Json?`). `@@index([type])`, `@@index([userId])`.
- This is the one genuinely shared, non-duplicated piece of cross-system
  infrastructure — both Scholar and Hospital OS write to the same table
  with the same helper (`recordAuditEvent`). Good precedent for future
  unification (see `docs/AAROGYA_TARGET_ARCHITECTURE.md`).
- **Gap**: no `facilityId`/`institutionId` column on `AuditEvent` itself —
  filtering audit history by tenant requires joining through `userId` →
  profile, which works but is indirect. Fine at current scale.

## 9. Cross-cutting gaps summary

1. **Plain-string "foreign keys"** (`BedStateEvent.patientId/encounterId/byUserId`,
   `Transfer.byUserId`, `Discharge.signedByStaffId`, `Vital.recordedByStaffId`,
   `MedicationOrder/LabOrder/ImagingOrder.orderedByStaffId` — wait, these
   last three *are* real relations; the ungoverned ones are specifically
   the "who/when" audit-style fields added for traceability rather than
   the primary clinical relations). Net effect: referential integrity for
   *audit trail* fields is weaker than for *clinical* fields. Acceptable
   for Phase 1, worth tightening before this data is relied on for
   compliance/legal purposes.
2. **`Float` for money** (`Charge.amount`, `Bill.totalAmount/paidAmount`) —
   should become `Decimal` (Prisma supports it; SQLite stores it as text
   internally, Postgres has a native type) before real billing.
3. **No `Room` entity** between `Ward` and `Bed`.
4. **No `EpisodeOfCare`** grouping related encounters or consolidating
   billing/discharge across a care journey that spans OPD → ED → IPD.
5. **Several enum-shaped fields are free-text** (`sex`, `Allergy.severity`,
   `ClinicalNote.status`, order `status` fields, `Bed.genderRestriction`) —
   a deliberate Phase 1 tradeoff (faster iteration, no migration needed to
   add a new status value) that should be revisited once the status sets
   stabilize.
6. **No soft-delete/archival pattern anywhere** — every model is either
   kept forever or hard-deleted; no `deletedAt` convention. Relevant to
   `docs/DATABASE_PRODUCTION_READINESS.md` (retention/legal hold).

## 10. Phase 1 addendum — schema changes and what they close

**`Patient` extended**: `preferredName`, `dobPrecision`, `address`,
`language`, `communicationPreference`, `registrationStatus`,
`deceasedAt`, `userId` (nullable unique — self-service portal linkage,
closes the "Role.PATIENT does nothing" gap from §1 of this doc),
`mergedIntoId`/`mergedAt` + self-relation `PatientMerge` (closes the "two
unrelated Patient rows for the same person" gap from §4), `updatedAt`.
`fullName` deliberately **not** renamed — see `docs/CLINICAL_CORE.md` §1.

**`PatientIdentifier` extended**: `issuer`, `status`. The `@@unique([type,
value])` gap noted in §4 above is **still open** — not fixed this phase.

**`Allergy` extended**: `status`, `verification` — closes part of the
"severity is free-text" gap (severity itself is still free-text; status/
verification are now real fields with defaults).

**New: `EpisodeOfCare`** — closes the §4 "no grouping of related
encounters" gap. `Encounter.episodeOfCareId` is optional (an encounter
need not belong to an episode), consistent with not forcing every walk-in
OPD visit into episode bookkeeping it doesn't need.

**New: `Diagnosis`**, distinct from `Problem` — see `docs/CLINICAL_CORE.md`
§5 for the distinction. `Encounter` gained a `CANCELLED` status and
`cancelledReason`.

**New: `Task`, `ClinicalDocument`, `Consent`, `Referral`,
`PatientMergeRecord`, `DepartmentMembership`** — see
`docs/CLINICAL_CORE.md` §2–§9 for the reasoning behind each; none of
these existed even as a gap note in the original Phase 0 audit above
because the target-model sections they implement (`TARGET_DOMAIN_
ARCHITECTURE.md` §2.3 for Task, the identity scoping model for
DepartmentMembership) were architecture-only until this phase.

**Still open, unchanged by Phase 1** (confirmed still true after this
phase's schema work): `Float` for money, no `Room` entity, several
enum-shaped fields remain free-text (`sex`, `Allergy.severity`, order
`status` fields), no soft-delete/archival pattern, the plain-string
"foreign key" audit fields (`BedStateEvent.patientId/encounterId/
byUserId`, `Transfer.byUserId`, `Discharge.signedByStaffId`,
`Vital.recordedByStaffId`).
