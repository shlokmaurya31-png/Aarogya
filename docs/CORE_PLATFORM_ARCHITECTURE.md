# Core Platform Architecture

Identifies which existing components are the right foundation to build the
four platform "cores" on, and which existing components are dead ends
that should be left alone (not deleted) but not extended further.

## Clinical Core (Patient, Encounter, Clinical Record, Orders, Results, Medications)

**Foundation: Hospital OS's existing implementation.**

- `Patient`, `Encounter`, `ClinicalNote`, `Problem`, `Allergy`, `Vital`,
  `MedicationOrder`/`MedicationAdministration`, `LabOrder`/`LabResult`,
  `ImagingOrder`/`ImagingReport` (all in `prisma/schema.prisma`) are the
  real, transactionally-consistent, tenant-scoped clinical data model.
  This is correct to build on — it already implements the single most
  important property a clinical core needs: one longitudinal record per
  patient queried across encounter types, not siloed per visit (verified
  in `docs/DATA_MODEL_AUDIT.md` §4).
- **Not a foundation candidate**: `PatientProfile`/`Prescription`/
  `TimelineEvent` (original prototype's TypeScript interfaces,
  `src/types/index.ts`, backing `usePatientStore`/`useRecordsStore`) —
  client-only, no server authority, cannot become source-of-truth data
  without a full rewrite onto the real schema. The eventual path (see
  `docs/AAROGYA_TARGET_ARCHITECTURE.md`) is migrating the *UI* that
  currently reads these stores onto the Clinical Core's real API/DB, not
  promoting the stores themselves.
- **Gap to close before this is a complete clinical core**: `Procedure`,
  `CarePlan` (see `docs/TARGET_DOMAIN_ARCHITECTURE.md`), and code/terminology
  binding on diagnosis/drug/test fields.
- **Phase 1 status**: `EpisodeOfCare`, `Diagnosis` (distinct from
  `Problem`), and `Referral` were built this phase — see
  `docs/CLINICAL_CORE.md` §5 for `Diagnosis`/`Referral` specifically. A
  server-side `Patient Summary` API and a real, request-time-aggregated
  `Longitudinal Timeline` (`src/lib/patient/{summary,timeline}.ts`) now
  exist and are wired into both the Doctor Workspace's `PatientChart` and
  a new patient self-service portal — this is the concrete implementation
  of "one longitudinal record per patient" referenced above, not just its
  precondition. Duplicate-patient detection and a safe, non-destructive
  logical merge (`src/lib/patient/{duplicateDetection,merge}.ts`) also
  shipped this phase, closing part of the `Patient` §4 gap noted in
  `docs/DATA_MODEL_AUDIT.md` (a patient seen at two facilities within the
  same organization can now at least be logically linked post-hoc, though
  cross-facility merge is still deliberately rejected — merge only
  resolves duplicates *within* one facility).

## Operational Core (Beds, Tasks, Queues, Departments, Staff)

**Foundation: Hospital OS's `Organization/Facility/Department/Ward/Bed` +
`HospitalStaffProfile` + the bed state machine.**

- `src/lib/hospital/bed.ts` (legal-transition table, unit-tested) and
  `admission.ts` (transactional admit/transfer/discharge) are correct,
  narrow, working building blocks — extend, don't replace.
- The Nursing task engine (`/api/hospital/nurse/tasks`) is currently a
  **computed view**, not a real `Task` entity (see
  `docs/TARGET_DOMAIN_ARCHITECTURE.md` §2.3) — this is the one place the
  Operational Core needs a genuine new entity before it can generalize
  beyond the two task types it has today.
- **Phase 1 status**: a real `Task` table now exists
  (`/api/hospital/tasks`) for task types with no natural home table
  (follow-ups, manual to-dos). Medication-due and vitals-due tasks
  deliberately were **not** migrated onto it — they remain computed views
  over `MedicationAdministration`/`Vital`, since duplicating rows that
  already have a natural home table would create a second source of
  truth. See `docs/CLINICAL_CORE.md` §4 for the full reasoning.
- **Not a foundation candidate**: `useHospitalOpsStore`/
  `useBedBookingStore` (original mock portal) — tracks bed *counts*, not
  bed *identity*, and has no staff/department real relational structure
  (`HospitalDoctorEntry`/`HospitalStaffMember` are flat arrays per
  hospital id, not linked to `User` at all). Superseded in shape by
  Hospital OS's real model; not deleted (still serving the `/hospital`
  mock portal, see `docs/IMPLEMENTATION_INVENTORY.md` §3), but nothing
  further should be built on it.
- Queues (OPD/lab/radiology/pharmacy/billing token queues, brief §164):
  **missing entirely** — Hospital OS has *worklists* (unordered lists
  filtered by status, e.g. the Lab Queue page) which is a reasonable
  Phase-1-appropriate substitute, but not a real FIFO/priority queue with
  position/wait-time. Real queue semantics belong to Phase 2 (OPD depth).

## Financial Core (Charges, Billing, Payments, Insurance)

**Foundation: Hospital OS's `Charge`/`Bill` charge engine.**

- Real, transactional, correctly denormalized for query simplicity (see
  `docs/DATA_MODEL_AUDIT.md` §6). This is the right shape to extend.
- **Critical gap before this can be called a real Financial Core**:
  `Bill.paidAmount` exists but nothing writes to it — there is no payment
  recording at all today, not even a stub. `Float` for money needs to
  become `Decimal` before real amounts flow through it (see
  `docs/DATABASE_PRODUCTION_READINESS.md` §9). Insurance/claims (brief
  §35) is entirely unbuilt — `docs/AAROGYA_TARGET_ARCHITECTURE.md`
  sequences this as Phase 5.
- **Not a foundation candidate**: nothing in the original prototype
  models billing at all (Insurance claims shown on the patient dashboard
  are static mock data, `InsuranceClaim` in `src/lib/mock-data.ts`, no
  real amounts, no real state machine).

## Intelligence Core (Events, Alerts, Analytics, AI)

**Foundation: split.**

- **Alerts**: `src/lib/hospital/alertEngine.ts` — real, deterministic,
  computed from live data, the correct pattern to extend with more rules
  as more modules are built (each new module adds its own rule functions
  to the same engine, or the engine is split per-module once it grows —
  not urgent at 6 rule types).
- **Events**: architecture-only (`docs/EVENT_ARCHITECTURE.md`) — nothing
  to build on yet, deliberately, until a real async consumer exists.
- **Analytics**: **missing** — the Command Center shows current-state
  snapshots (`docs/DATA_MODEL_AUDIT.md`-verified live aggregates), not
  historical trend analytics. No time-series storage, no drill-down
  beyond what a single Prisma query already returns. This is honestly
  absent, not faked with placeholder charts — confirmed by the UI audit
  (`docs/UI_ARCHITECTURE_AUDIT.md` §8).
- **AI**: Scholar's `AIProvider` abstraction (`src/lib/ai/provider.ts` +
  `mockProvider.ts`/`anthropicProvider.ts`) is the right shape to reuse
  for a future Hospital OS AI copilot — same interface pattern (server-
  side only, deterministic mock fallback, never a database write path
  from AI output without a human action in between, per
  `docs/CLINICAL_SAFETY_AUDIT.md` §1.1's override pattern). **Not yet
  instantiated for Hospital OS** — no clinical summary/documentation-
  assistant/operations-analysis copilot exists for the hospital domain,
  by design this phase.

## Identity / IAM and Tenant Core

**Foundation: Scholar's original auth primitives, now shared.**

- `src/lib/auth/{session,password,rbac,permissions}.ts` — password
  hashing, signed sessions, permission table, all shared verbatim between
  Scholar and Hospital OS (not duplicated — this is the one clean
  cross-system reuse story in the codebase, confirmed in
  `docs/IMPLEMENTATION_INVENTORY.md` §9).
- `hospitalRbac.ts`'s `requireFacilityStaff()` is the Tenant Core's actual
  implementation — correctly derives tenant from a server-side profile
  lookup, never client input (except the documented `AAROGYA_ADMIN`
  cross-facility exception).
- **Gap**: no session revocation, no rate limiting (both flagged CRITICAL/
  HIGH in `docs/SECURITY_AUDIT.md`) — these are Identity/IAM gaps that
  block calling this "production-ready" identity infrastructure, even
  though the RBAC/tenancy *shape* is correct. **Still open after Phase 1**
  — not addressed this phase, which was scoped to clinical-core and
  multi-facility tenancy, not to the session-security gaps themselves.
- **Not a foundation candidate**: `useAuthStore` (original prototype) —
  see `docs/SECURITY_AUDIT.md` S-01. This is the system Identity/IAM
  needs to eventually replace, not extend.
- **Phase 1 status**: `DepartmentMembership` was added (see
  `docs/CLINICAL_CORE.md` §2) — the one piece of scoped-role membership
  beyond a staff member's single primary `HospitalStaffProfile` facility/
  department. Multi-facility organization tenancy is now real (a second
  facility, Noida, exists alongside Pune under the same demo
  `Organization`, each with its own departments/wards/beds/staff/patients)
  and cross-facility tenant isolation was live-verified end-to-end this
  phase — see `docs/AAROGYA_TARGET_ARCHITECTURE.md` §6 and the Phase 1
  final report's Security Test Results.

## Summary table

| Core | Foundation exists? | Where | Biggest gap |
|---|---|---|---|
| Clinical | Yes, solid | Hospital OS schema + Phase 1 additions (EpisodeOfCare/Diagnosis/Referral, timeline/summary aggregation) | Procedure/CarePlan, terminology binding, generalized Order table |
| Operational | Yes, solid | Hospital OS bed/admission/staff model + Phase 1 `Task` table | Real queues; medication/vitals tasks still computed views (deliberately) |
| Financial | Yes, narrow | Hospital OS charge/bill engine | Payments, Decimal money, Insurance |
| Intelligence | Partial | Alert engine yes, events/analytics/AI-for-hospital no | Analytics + hospital AI copilot both unbuilt |
| Identity/IAM + Tenant | Yes, correct shape, gaps in maturity | Scholar's auth stack, shared; multi-facility tenancy now real (Phase 1) | Session revocation, rate limiting (unchanged by Phase 1) |
