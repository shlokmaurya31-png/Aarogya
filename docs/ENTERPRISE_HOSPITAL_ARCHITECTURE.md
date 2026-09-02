# Aarogya Hospital OS — Enterprise Architecture

This document covers the transformation of Aarogya from a prototype into the
beginning of an enterprise Hospital Operating System. It follows the same
honesty conventions as `docs/STUDENT_PLATFORM_ARCHITECTURE.md`: it describes
what exists, what was built in this pass, and what is deliberately deferred —
it does not claim completeness the code doesn't have.

## 1. Existing architecture discovered

By this point the repository already has **two** persistence models living
side by side (see `docs/STUDENT_PLATFORM_ARCHITECTURE.md` §2.10):

1. **The original Patient/Doctor/Hospital prototype** — pure Zustand,
   `localStorage`-persisted, no server authority. This includes an existing
   **`/hospital` route** (`src/app/hospital/page.tsx`) — a real, working,
   single-tenant hospital-admin portal for the `hospital` auth role, with
   Overview/Beds/Patients/Doctors/Staff/Departments/Analytics tabs backed by
   `useHospitalOpsStore` + `useBedBookingStore`. It seeds 4 doctors, 7 staff,
   7 admissions per hospital account, supports admit/discharge/transfer,
   vitals, and clinical notes — entirely client-side.
2. **Aarogya Scholar** (added in the prior change) — Prisma + SQLite, real
   password hashing, signed sessions, server-side RBAC, `AuditEvent`,
   `Role` enum (`PATIENT, DOCTOR, STUDENT, EDUCATOR, INSTITUTION_ADMIN,
   AAROGYA_ADMIN`).

### 1.1 Critical routing decision

This brief asks for a `/hospital` route tree (`/hospital`, `/hospital/beds`,
`/hospital/emergency`, `/hospital/icu`, `/hospital/finance`, ...) as the new
enterprise Hospital Command Center. **That path is already a real, working
feature.** Overwriting it would violate the brief's own instruction not to
break existing functionality or delete existing work.

**Decision**: the new, database-backed Hospital OS is built under
**`/hospital-os`** instead of `/hospital`. The existing `/hospital` mock
portal is untouched and still reachable from the `hospital` role login. This
mirrors the precedent set for Aarogya Scholar (`/student`, not `/dashboard`).
A future migration phase can retire the old mock portal and redirect
`/hospital` → `/hospital-os` once the new system covers everything the old
one does (see §12 "Migration path"). Every module route below is written as
`/hospital-os/...`, substituting for the brief's `/hospital/...` paths.

## 2. Scope of this pass

213 sections describe a multi-year enterprise HIS/EMR/ERP platform (patient
flow, bed/ICU/OT/lab/radiology/pharmacy/blood-bank, billing/insurance/claims,
inventory/procurement, HR/rostering, quality/accreditation, facilities,
multi-tenant SaaS billing, ABDM/FHIR/DICOM interoperability, AI copilots for
every department, mobile apps, voice, offline mode...). Section 193 of the
brief itself says not to build all of this simultaneously and gives a
phase list. This pass builds **Phase 1** for real, with genuine backend
depth, and documents Phases 2–4 as architecture only:

**Built this pass (Phase 1, per brief §193)**: tenancy (Organization →
Facility → Department → Ward → Bed), RBAC/roles, audit, patient master +
longitudinal encounter record, OPD/ED registration, admission/transfer/
discharge with real bed-state transactions, Hospital Command Center with
data-derived (not decorative) widgets and an alert engine, Doctor Workspace
(patient chart, orders, notes), Nursing task engine + medication
administration record, Lab order→result workflow with critical-value
handling, Radiology order→report workflow, a billing charge engine, and a
Discharge Command Center that shows *why* each patient hasn't left.

**Architected but not built this pass** (interfaces/docs only, or entirely
deferred — see §11): ICU flowsheets/ventilator parameters, OT scheduling,
Blood Bank, Pharmacy inventory/procurement, full Insurance/TPA claim
lifecycle UI, Quality/Incident/CAPA module, Infection Control, HR/rostering,
Facilities/biomedical equipment, ABDM/FHIR/DICOM adapters (interfaces only,
matching the Scholar pass's `ClinicalCaseProvider` pattern), AI copilots
beyond what Scholar already built, multi-facility SaaS billing/licensing,
mobile apps, offline mode, voice.

## 3. Tenancy model

```
Organization (e.g. "Aarogya Health Network")
  └─ Facility (e.g. "Aarogya Medical Centre, Pune")
       └─ Department (e.g. "Cardiology", "Emergency")
            └─ Ward (e.g. "ICU", "General Ward B")
                 └─ Bed
```

Every hospital-domain row that isn't organization-wide carries a
`facilityId`, and most carry a `departmentId`. `requireFacilityStaff()`
(`src/lib/auth/hospitalRbac.ts`) — the hospital-domain analogue of Scholar's
`requireVerifiedStudent()` — loads the caller's `HospitalStaffProfile`,
confirms it's `ACTIVE`, and returns their `facilityId` so every route can
scope its Prisma queries (`where: { facilityId }`) rather than trusting a
facility ID the client sends. This is the tenant-isolation boundary — see
`docs/STUDENT_PLATFORM_THREAT_MODEL.md`-style threats in
`docs/HOSPITAL_THREAT_MODEL.md` T-01.

`AAROGYA_ADMIN` (renamed conceptually to platform "SUPER_ADMIN" for the
hospital domain, same enum value) can query across facilities; every other
hospital role is facility-scoped.

## 4. Roles added

Extends the existing `Role` enum (Scholar's `PATIENT/DOCTOR/STUDENT/
EDUCATOR/INSTITUTION_ADMIN/AAROGYA_ADMIN`) with the Phase-1-relevant subset
of brief §62's full list — not all ~35 roles, since most (SURGEON,
ANESTHETIST, RADIOLOGIST vs RADIOLOGY_TECH, PROCUREMENT, FACILITY_MANAGER,
BIOMEDICAL_ENGINEER, HOUSEKEEPING, AMBULANCE, MEDICAL_RECORDS...) belong to
modules not built this pass. Added: `HOSPITAL_ADMIN, NURSE,
LAB_TECHNICIAN, RADIOLOGY_TECH, PHARMACIST, BILLING_STAFF`. `DOCTOR`
(already in the enum from Scholar, previously unused by any real feature) is
now backed by the real Doctor Workspace. Permission strings follow the same
`resource:action` convention as Scholar's `PERMISSIONS` table
(`src/lib/auth/permissions.ts`), extended with `patient:*`, `encounter:*`,
`clinical:*`, `medication:*`, `lab:*`, `imaging:*`, `bed:*`, `billing:*`,
`hospital:admin:*`.

## 5. Core data entities

See `prisma/schema.prisma` for the authoritative source. New models:
`Organization, Facility, Department, Ward, Bed, BedStateEvent,
HospitalStaffProfile, Patient, PatientIdentifier, Allergy, Encounter,
Admission, Transfer, Discharge, ClinicalNote, Problem, Vital,
MedicationOrder, MedicationAdministration, LabOrder, LabResult,
ImagingOrder, ImagingReport, Charge, Bill`. Hospital-domain audit events
reuse Scholar's existing generic `AuditEvent` model (new `type` string
values only, e.g. `admission.created`, `bed.stateChanged`,
`medication.administered`) rather than a parallel audit table.

Design choices carried over from Scholar's persistence layer
(`docs/STUDENT_PLATFORM_ARCHITECTURE.md` §2.1): SQLite for local dev,
Postgres-portable types, `cuid()` ids, `Json` columns only where genuinely
unstructured (e.g. a note's structured SOAP fields). `AuditEvent` (Scholar's
generic audit table) is reused rather than duplicated — hospital actions
just add new `type` string values (`admission.created`, `bed.stateChanged`,
`medication.administered`, `lab.criticalResultAcknowledged`, ...).

### 5.1 Encounter model

A `Patient` accumulates multiple `Encounter`s (OPD, ED, IPD, daycare) over
time — never separate disconnected histories per visit type, per brief §69.
An `Admission` references its originating `Encounter`; `ClinicalNote`,
`Vital`, `ClinicalOrder`, `MedicationOrder` all reference `encounterId` so
the patient's longitudinal record is a query across encounters, not a
per-encounter silo.

### 5.2 Patient identity

`Patient.uhid` is the internal immutable identifier (brief §70 — "do not
assume ABHA is the hospital's internal patient ID"). `PatientIdentifier` is
a separate table for external identifiers (ABHA, insurance member ID, a
prior system's MRN) — many-to-one with `Patient`, so a future ABDM
integration adds rows here without touching `Patient.uhid`.

## 6. Bed state machine

`Bed.status`: `AVAILABLE, OCCUPIED, RESERVED, CLEANING, BLOCKED,
MAINTENANCE, ISOLATION, TRANSFER_PENDING` (brief §8). Every transition is
recorded as a `BedStateEvent` (who, when, from, to, reason) — this is what
powers "why is this bed blocked" in the Command Center, not a single mutable
`status` column with no history. Admission, transfer, and discharge each run
inside a single Prisma `$transaction` that (a) updates the bed status, (b)
writes the `BedStateEvent`, and (c) writes the clinical event (`Admission`/
`Transfer`/`Discharge` row) atomically — see brief §129 "database
transactions", satisfied for this pass's critical paths.

## 7. Command Center — "why", not just numbers

Per brief §137, every widget on `/hospital-os` is computed from the database
at request time, not a static number. `getCommandCenterSnapshot()`
(`src/lib/hospital/commandCenter.ts`) computes:

- Bed occupancy by status/ward, computed from live `Bed` rows.
- Patient counts by encounter type/stage, computed from `Encounter` rows
  with no `Discharge`.
- An **alert list** generated by `src/lib/hospital/alertEngine.ts` — rule
  functions that scan the DB for real conditions (blocked beds older than a
  threshold, unacknowledged critical lab results, discharge-ready patients
  whose `Discharge` row is still missing a required sub-status, encounters
  with no bed after N minutes) and emit `{severity, department, message,
  ownerRole}` — never a decorative "43 admissions today" without the
  comparison/reason the brief asks for in §137.

This is intentionally a **deterministic rule engine**, not an LLM — matching
the "do not invent analytics" instruction in §138 and the Scholar precedent
of keeping anything that drives a number or a decision deterministic, with
AI layered on top only as narrative (not built in this pass for the
hospital side — see §11).

## 8. Clinical safety

`src/lib/hospital/clinicalSafety.ts` implements the brief §20/§101 CDS
architecture for what Phase 1 actually touches: **allergy checking** at
medication-order time (`MedicationOrder` creation cross-references
`Patient`'s `Allergy` rows) and **duplicate active medication** checking.
Every flag raised carries `{rule, severity, sourceAllergyId}` and requires
an explicit `overrideReason` to proceed — it never silently blocks or
silently allows. This is deliberately narrow (two rule types) rather than
the full §20 list (drug interaction database, renal dosing, sepsis risk
scoring, fall risk) — those need real clinical reference data this
prototype doesn't have, and are documented as deferred rather than faked
with placeholder logic that would look real but isn't (brief §205's test
explicitly checks the allergy path works and is never AI-overridden).

## 9. Doctor Workspace, Nursing, Lab, Radiology, Billing

See inline module docs in `src/lib/hospital/*` and the route list in §10.
Each follows the same shape as Scholar's case engine: a pure domain function
(e.g. `admitPatient()`, `releaseLabResult()`) that a thin API route wraps
after an RBAC + tenant check, so business logic never lives in a React
component (brief §131/§201).

## 10. Routes

```
/hospital-os                          Hospital Command Center
/hospital-os/beds                     Bed board (ward map, state, allocation)
/hospital-os/admissions               Admission worklist + new-admission flow
/hospital-os/patient-flow             Per-patient journey timeline + bottleneck view
/hospital-os/discharge                Discharge Command Center
/hospital-os/doctor                   Doctor Workspace (patient list, home)
/hospital-os/doctor/patients/[id]     Patient longitudinal chart + order entry
/hospital-os/nurse                    Nursing Command Center (tasks, MAR)
/hospital-os/lab                      Lab order queue → result entry → release
/hospital-os/radiology                Imaging order queue → report entry → release
/hospital-os/billing                  Charge engine + bill view

/api/hospital/command-center
/api/hospital/beds
/api/hospital/beds/[id]/transition
/api/hospital/admissions
/api/hospital/admissions/[id]/transfer
/api/hospital/admissions/[id]/discharge
/api/hospital/patients
/api/hospital/patients/[id]
/api/hospital/patients/[id]/chart
/api/hospital/encounters/[id]/notes
/api/hospital/encounters/[id]/orders
/api/hospital/orders/medication
/api/hospital/orders/medication/[id]/administer
/api/hospital/orders/lab
/api/hospital/orders/lab/[id]/result
/api/hospital/orders/imaging
/api/hospital/orders/imaging/[id]/report
/api/hospital/billing/[encounterId]
/api/hospital/nurse/tasks
```

## 11. Explicitly deferred (architected in prose only)

- **ICU/OT/Blood Bank/Pharmacy-inventory/Insurance-claims/Quality-CAPA/
  Infection-Control/HR-rostering/Facilities-equipment** modules: data model
  sketched in §68 of the brief is *not* added to `schema.prisma` this pass
  — adding 60+ more speculative tables with no working workflow behind them
  would violate brief §210 ("do not use mock data where a real domain model
  is required" cuts both ways: an unused table is not better than an
  honestly-absent one).
- **ABDM/FHIR/DICOM**: no adapters added this pass. The Scholar precedent
  (`ClinicalCaseProvider` interface + only a synthetic implementation
  wired up) is the intended shape for these — build when a real
  integration is scoped, not before.
- **Multi-facility SaaS billing/licensing, mobile apps, offline mode,
  voice, AI hospital/nursing/pharmacy copilots**: no code this pass.
- **Full RBAC role list** (§62): narrowed to the 6 new roles Phase 1
  actually uses (see §4). Extending the enum further is a one-line change
  when a module that needs e.g. `SURGEON` or `PROCUREMENT` gets built.

## 12. Migration path

1. This pass: `/hospital-os` stands alongside the untouched `/hospital`
   mock and Scholar's `/student`.
2. Next: migrate the `hospital` auth role's users onto the new
   `HospitalStaffProfile`/session system (same pattern as the Scholar
   migration note in `docs/STUDENT_PLATFORM_ARCHITECTURE.md` §2.10),
   feature-match the old portal's admit/transfer/discharge/notes/vitals
   flows (already superset-covered by the new bed-transaction system),
   then redirect `/hospital` → `/hospital-os` and retire
   `useHospitalOpsStore`/`useBedBookingStore`.
3. Later: build Phase 2 modules (Emergency triage depth, ICU, OT,
   Inventory, Insurance, Quality, Infection Control, Workforce) on the same
   tenancy/RBAC/audit foundation.
