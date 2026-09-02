# Implementation Inventory — Phase 0 Audit

This document classifies every major feature area in the Aarogya repository
against what actually exists in code, verified against the implementation
(not against prior README/docs claims — those are corrected where wrong).
Classification legend: **IMPLEMENTED** (functional end-to-end, DB-backed) ·
**PARTIAL** (real but incomplete) · **UI ONLY** (frontend, no real backend) ·
**MOCK** (client-only/Zustand/demo data) · **ARCHITECTURE ONLY** (interfaces/
docs, no working implementation) · **BROKEN** (exists, malfunctions) ·
**MISSING** (does not exist).

Audited at commit `87ce931` (`main`, pushed, clean tree).

---

## 1. Patient / Doctor prototype (original system)

**Classification: MOCK** (entirely client-side, by original design — this
was never claimed to be more than a prototype).

- Location: `src/app/dashboard/page.tsx`, `src/components/{dashboard,views,patient,timeline,charts}/`, `src/store/{useAuthStore,usePatientStore,useRecordsStore,useUiStore}.ts`, `src/lib/mock-data.ts`.
- "Authentication": `useAuthStore.signInPatient/signInDoctor` accept almost
  any email + password ≥4 chars and fabricate a `AuthUser` object. No
  server round-trip, no password check, no session. Persisted to
  `localStorage` under key `aarogya-auth`.
- "Records": `usePatientStore`/`useRecordsStore` hold vitals, body systems,
  timeline, appointments, reports, prescriptions, insurance claims —
  either static from `src/lib/mock-data.ts` or user-entered during
  onboarding, held in browser state only.
- Doctor-authored prescriptions (`useRecordsStore.addPrescription`) write
  to the same client store the patient view reads — this is why they
  "show up live" in the patient's Medicines view (both are the same
  in-memory object graph in the same browser tab, not a real read/write
  round trip through any server).
- Database models: **none**. No `Patient`, `Prescription`, `Appointment`
  Prisma model backs this system.
- APIs: only `/api/chat` (AI assistant) and `/api/admin-auth` touch a
  server for this system; both are stateless (no session, no DB write).
- Tests: none.
- Current limitation: this is a genuine, working demo experience for a
  single browser session, but there is no multi-device, multi-user, or
  persistent-across-sessions-on-another-machine capability, and zero
  server-side authorization — anyone with browser devtools can edit any
  field in `localStorage`.

## 2. Admin panel (original system)

**Classification: MOCK**, with one **PARTIAL** real piece.

- Location: `src/app/admin/`, `src/components/admin/`, `src/store/useAuthStore.ts`.
- `signInAdmin` is the one exception: it POSTs to `/api/admin-auth`
  (`src/app/api/admin-auth/route.ts`), which checks `email`/`password`
  against `ADMIN_EMAIL`/`ADMIN_PASSWORD` env vars server-side. This is
  **PARTIAL**: it's a real server check, but there is no session issued
  afterward — the client just sets local `user` state on a 200 response.
  A page refresh with no cookie/token means "logged in" is purely a
  client-memory/localStorage fact, not a verified server fact on
  subsequent requests. `/admin/(dashboard)/*` pages read
  `useAuthStore.user` and redirect client-side if absent — this is
  navigation-level gating, not authorization (see `docs/SECURITY_AUDIT.md`
  finding S-01).
- `verificationApplications` (doctor/lab/hospital signup approval queue):
  pure Zustand state seeded with 3 hardcoded applications, persisted to
  `localStorage`. Approve/reject/CSV export all operate on this local
  array. No `VerificationApplication` Prisma model exists.
- `/admin/student-verifications` (added this session) is the one place in
  the admin area that is **IMPLEMENTED**: it requires its own real
  `AAROGYA_ADMIN` session (`getCurrentUser()`) and reads/writes
  `StudentProfile.verificationStatus` in Postgres-portable SQLite via
  Prisma. It sits inside the same visual shell as the mock admin panel
  but is a structurally separate auth system (see §9, Duplication).

## 3. Original Hospital portal (`/hospital`)

**Classification: MOCK**, functionally deep.

- Location: `src/app/hospital/page.tsx`, `src/components/hospital/*`
  (2,047 lines across 8 tab components), `src/store/{useHospitalOpsStore,useBedBookingStore}.ts`.
- This is a real, single-tenant, client-side hospital-admin UI: Overview,
  Beds, Patients, Doctors, Staff, Departments, Analytics tabs. Supports
  admit/discharge/transfer, vitals updates, clinical notes, bed-count
  tracking per ward (`emergency`/`icu`/`general` — a fixed 3-category
  model, not the Hospital OS's flexible `Ward`/`WardType`).
  `useHospitalOpsStore.admitPatient` decrements a bed counter in
  `useBedBookingStore`; there is no `Bed` entity, only a count.
- Auth: `user.role === "hospital"`, same client-only pattern as §1.
- Database: none. `HospitalAdmission`, `HospitalDoctorEntry`,
  `HospitalStaffMember` (see `src/types/index.ts`) are TypeScript
  interfaces only, never Prisma models.
- This is the system Hospital OS (§6) is the eventual real-backend
  replacement for — see `docs/ENTERPRISE_HOSPITAL_ARCHITECTURE.md` §1.1
  and the migration path in §12 of that document.

## 4. AI Assistant (`/api/chat`)

**Classification: PARTIAL** (real API call, no persistence).

- Location: `src/app/api/chat/route.ts`, `src/components/ai/AiAssistantPanel.tsx`.
- Real: server-side call to `@anthropic-ai/sdk` with a system prompt built
  by serializing the current client-held patient/doctor data into text.
  Requires `ANTHROPIC_API_KEY`; returns 500 if absent (no mock fallback —
  contrast with Scholar's `AIProvider`, see §7).
- Not real: nothing is persisted. Chat history lives in component state,
  lost on refresh. The "AI adds a report to your Reports" behavior writes
  to the same client-only `usePatientStore`/`useRecordsStore` as §1.
- Known lint issues in this file's sibling component
  (`AiAssistantPanel.tsx`): 2 pre-existing ESLint errors
  (`react-hooks/set-state-in-effect`, `react-hooks/purity`) — see
  `docs/SECURITY_AUDIT.md` is not the right place, noted here and in the
  final report §L as a documented-not-fixed pre-existing issue, unrelated
  to any system built this session.

## 5. Aarogya Scholar (`/student`, `/educator`, `/admin/student-verifications`)

**Classification: IMPLEMENTED** for the core loop; **PARTIAL**/**MISSING** for
breadth items explicitly deferred in its own architecture doc.

- Location: `src/app/student/`, `src/app/educator/`, `src/app/api/{student,educator,scholar-auth}/`, `src/lib/{auth,privacy,clinical,caseEngine,scoring,rxlab,ai,verification}/`, `prisma/schema.prisma` (Scholar section), `prisma/seedData/`.
- Real, DB-backed, server-authorized: account creation + scrypt password
  hashing + signed-cookie sessions (`src/lib/auth/session.ts`), RBAC
  (`permissions.ts`/`rbac.ts`), student verification workflow (wizard →
  `StudentProfile` row → admin review), a server-authoritative case state
  machine (`src/lib/caseEngine/engine.ts`) where the answer key
  (`ClinicalCase.rubric/referenceDx/content.managementPathway[].isCritical`
  etc.) never reaches the client pre-submission (`publicView.ts` strips
  it), deterministic scoring (`src/lib/scoring/engine.ts`), RxLab
  prescription validation, AI viva/tutor with a working deterministic
  fallback (`MockAIProvider`) when no API key is present, competency
  roll-up, achievement granting.
- 25 distinct synthetic teaching cases (`prisma/seedData/cases/*.ts`),
  8 achievements, demo accounts across MBBS/Nursing/Pharmacy tracks.
- Educator authoring: **PARTIAL** — creates a structurally valid draft
  case (title/specialty/presentation/reference diagnosis/learning
  objectives) but with empty `historyTree`/`examFindings`/
  `investigations`/`managementPathway` arrays; there is no multi-step
  authoring wizard matching the full `ClinicalCaseFull` shape the case
  engine expects for a rich case.
- **MISSING** (documented as deferred in
  `docs/STUDENT_PLATFORM_ARCHITECTURE.md` §4, not silently absent):
  Grand Rounds, Emergency Arena countdown/deterioration simulation,
  standalone Diagnostic Lab drills, Knowledge Hub content, institution/
  cohort-scoped educator analytics, `HUNDRED_CASES`/`ECG_APPRENTICE`
  achievement auto-granting logic.
- Tests: `src/lib/{privacy,caseEngine,scoring,rxlab,ai,auth}/*.test.ts` —
  pure-function unit tests, no integration tests against the live DB.

## 6. Aarogya Hospital OS (`/hospital-os`)

**Classification: IMPLEMENTED** for the Phase-1 core it targeted;
**MISSING** for everything explicitly deferred in its architecture doc.

- Location: `src/app/hospital-os/`, `src/app/api/hospital/`, `src/components/hospital-os/`, `src/lib/hospital/`, `prisma/schema.prisma` (Hospital OS section), `prisma/seedData/hospital.ts`.
- Real, DB-backed, tenant-scoped, transactional: `Organization → Facility →
  Department → Ward → Bed` hierarchy; longitudinal `Patient`/`Encounter`
  record across OPD/ED/IPD; bed state machine with an explicit legal-
  transition table (`src/lib/hospital/bed.ts`, unit-tested) and an
  auditable `BedStateEvent` on every change; admission/transfer/discharge
  each execute as a single `prisma.$transaction()`; medication ordering
  runs a real allergy + duplicate-active-medication check
  (`clinicalSafety.ts`) that blocks on a danger flag unless an explicit,
  persisted override reason is given; a Nursing task engine computing
  medications-due/vitals-due from live order data with a real medication
  administration record; Lab/Radiology order → result/report queues with
  a critical-value acknowledgement workflow that never auto-clears; a
  billing charge engine rolling into a per-encounter `Bill`; a Command
  Center whose alert feed (`alertEngine.ts`) is a deterministic scan over
  real rows (blocked-bed duration, unacknowledged critical results,
  stalled discharges, bed-occupancy threshold) — no hardcoded numbers.
- 6 new roles (`HOSPITAL_ADMIN, NURSE, LAB_TECHNICIAN, RADIOLOGY_TECH,
  PHARMACIST, BILLING_STAFF`), each with a narrowed permission set,
  server-checked via `requireFacilityStaff()`.
- Demo hospital seeded ("Aarogya Medical Centre": 8 departments, 7 wards,
  40 beds, 30 staff, 30 patients/encounters), idempotent on re-seed
  (fixed a real duplication bug found during this session's own testing —
  see git history `852c0f9`..`87ce931`).
- **MISSING** (documented, not built): ICU flowsheets, OT scheduling,
  Blood Bank, Pharmacy inventory/procurement, full Insurance/TPA claim
  lifecycle, Quality/Incident/CAPA, Infection Control, HR/rostering,
  Facilities/biomedical equipment, ABDM/FHIR/DICOM adapters, AI copilots
  for this domain, multi-facility SaaS billing/licensing.
- **PARTIAL / known gap**: cross-facility tenant isolation is architected
  (`requireFacilityStaff` derives `facilityId` server-side) but not
  load-tested against a second seeded facility — only one facility exists
  in the seed data (see `docs/SECURITY_AUDIT.md` S-05).
- Tests: `src/lib/hospital/bed.test.ts` (state machine) +
  `src/lib/auth/permissions.test.ts` (RBAC boundary). No integration
  tests against the live DB for admission/discharge/order transactions.

## 7. AI provider architecture

**Classification: split** — Scholar's is **IMPLEMENTED**; the original
Patient/Doctor's is **PARTIAL**; Hospital OS has **no AI layer (MISSING,
by design this phase)**.

- `src/lib/ai/provider.ts` (`AIProvider` interface) +
  `anthropicProvider.ts` + `mockProvider.ts` + `getAIProvider.ts`: real
  abstraction, used only by Scholar's viva/tutor/patient-dialogue
  features. Falls back to a deterministic mock with no API key — the
  original `/api/chat` route does **not** use this abstraction and has no
  fallback (a design inconsistency, not a bug — `/api/chat` predates this
  abstraction and was not migrated onto it this session).

## 8. Route inventory

All routes as of this audit (39 pages, 42 API routes, 5 layouts):

| Route | Purpose | Backend | Database | Auth | Status |
|---|---|---|---|---|---|
| `/` | Marketing landing page | none | none | none | IMPLEMENTED (static) |
| `/dashboard` | Patient/Doctor prototype | none | none (Zustand) | client-only | MOCK |
| `/login`, `/onboarding`, `/settings` | Patient/Doctor auth + onboarding | none | none (Zustand) | client-only | MOCK |
| `/prescriptions/[id]` | Standalone prescription doc view | none | none (Zustand) | client-only | MOCK |
| `/lab` | Lab portal (original) | none | none (Zustand) | client-only | MOCK |
| `/hospital` | Original hospital-admin portal | none | none (Zustand) | client-only | MOCK |
| `/admin/login`, `/admin`, `/admin/directory`, `/admin/staff`, `/admin/verifications` | Admin panel (original) | `/api/admin-auth` only | none (Zustand) | partial server check, no session | MOCK (+ 1 PARTIAL route) |
| `/admin/student-verifications` | Scholar student verification review | `/api/admin/verifications/students` | Prisma (SQLite) | real session + RBAC | IMPLEMENTED |
| `/student`, `/student/verify` | Scholar landing + verification wizard | `/api/student/register`, `/api/scholar-auth/*` | Prisma | real session (post-login) | IMPLEMENTED |
| `/student/(app)/*` (dashboard, cases, cases/[id], rxlab, viva, progress, passport, notebook, profile, emergency) | Scholar authenticated app | `/api/student/*` | Prisma | real session + RBAC + verified-status gate | IMPLEMENTED |
| `/educator/*` | Educator case list + minimal authoring | `/api/educator/cases` | Prisma | real session + RBAC | PARTIAL (see §5) |
| `/hospital-os/login` | Hospital OS sign-in | `/api/scholar-auth/login` | Prisma | public | IMPLEMENTED |
| `/hospital-os/(app)/*` (command center, beds, admissions, discharge, doctor, doctor/patients/[id], nurse, lab, radiology, billing) | Hospital OS authenticated app | `/api/hospital/*` | Prisma | real session + RBAC + facility scoping | IMPLEMENTED |
| `/api/chat` | AI assistant (Patient/Doctor) | Anthropic SDK direct | none | none (no session check) | PARTIAL |
| `/api/admin-auth` | Admin credential check | env var check | none | none (no session issued) | PARTIAL |
| `/api/scholar-auth/{login,logout,me}` | Shared session auth for Scholar + Hospital OS | scrypt + signed cookie | Prisma `User` | — | IMPLEMENTED |
| `/api/student/*` (11 routes) | Scholar case engine, dashboard, notebook, progress, viva, rxlab, verification | full server logic | Prisma | RBAC + verified-status | IMPLEMENTED |
| `/api/educator/cases` | Educator case list/create | server logic | Prisma | RBAC | PARTIAL |
| `/api/admin/verifications/students` | Admin verification review | server logic | Prisma | RBAC | IMPLEMENTED |
| `/api/hospital/*` (22 routes) | Hospital OS domain APIs | full server logic + transactions | Prisma | RBAC + facility scoping | IMPLEMENTED |

**Note on "Auth" column**: "client-only" means the route enforces nothing
server-side — a direct API/URL visit with no cookie at all still serves
data, because the "logged in" check happens in a React component after
render. "real session" means a signed httpOnly cookie is verified
server-side on every request via `requireSession()`/`requirePermission()`/
`requireFacilityStaff()`/`requireVerifiedStudent()` before any data is
returned.

## 9. Duplication (see also `docs/SECURITY_AUDIT.md` and `docs/CORE_PLATFORM_ARCHITECTURE.md`)

| Concept | Representation 1 | Representation 2 | Representation 3 | Conflict |
|---|---|---|---|---|
| "Patient" | `PatientProfile` (TS interface, `src/types/index.ts`) — Zustand, one per browser | `Patient` (Prisma model) — Hospital OS, real DB row, one per facility | `ClinicalCase.patientName/patientAgeBand/patientSex` (Scholar's "educational patient") — not a real person at all | Three unrelated meanings of "patient" exist with no shared identifier or migration path today |
| "Admission"/bed occupancy | `HospitalAdmission` (TS interface) + bed *counts* in `useBedBookingStore` | `Admission` (Prisma model) + `Bed` rows with a real state machine | — | Old system tracks a count; new system tracks individual bed identity + audit trail. Not reconciled. |
| "User"/auth | `AuthUser` (TS interface, Zustand, `useAuthStore`) — patient/doctor/lab/hospital/admin/staff roles, no real password check for most | `User` (Prisma model) — STUDENT/EDUCATOR/DOCTOR/HOSPITAL_ADMIN/NURSE/etc., real scrypt hash + signed session | — | Two disjoint account systems. A `DOCTOR` role exists in both — Scholar/Hospital OS's `Role.DOCTOR` enum value and the old system's `role: "doctor"` string are **not the same account** and never overlap. |
| Verification queue | `VerificationApplication` (Zustand array, doctor/lab/hospital) | `StudentProfile.verificationStatus` (Prisma) | — | Same UX pattern (submit → admin approve/reject), two separate data stores, reviewed from two different admin surfaces (`/admin/verifications` vs `/admin/student-verifications`) requiring two separate logins |
| "Prescription" | `Prescription` (TS interface, Zustand) — real-looking but non-binding demo prescription | RxLab `PrescriptionEntry` (Scholar, in-memory during a case, watermarked "not a valid prescription") | `MedicationOrder` (Prisma, Hospital OS) — real clinical order | Three different "prescription" concepts with different legal/clinical weight, no shared type |
| Audit logging | none | `AuditEvent` (Prisma, generic `type` string) — used by both Scholar and Hospital OS | — | Not duplicated — this is the one place Scholar and Hospital OS correctly *share* infrastructure |
| Toast/notification UI | `useToastStore` — used by original system, Scholar, and Hospital OS alike | — | — | Not duplicated — genuinely shared, one of the few cross-system UI primitives |

**Root cause** (expanded in `docs/CORE_PLATFORM_ARCHITECTURE.md`): the
original prototype was never designed to have a database, so when Scholar
and Hospital OS needed real persistence, each was built additively with
its own auth/session system rather than retrofitting the old one — this
was a deliberate, documented decision each time (avoid breaking existing
features) but it has produced exactly the "multiple competing sources of
truth" problem this Phase 0 audit was asked to surface. See
`docs/AAROGYA_TARGET_ARCHITECTURE.md` for the unification target and
`docs/IMPLEMENTATION_ROADMAP.md` Phase 1 for the sequencing.
