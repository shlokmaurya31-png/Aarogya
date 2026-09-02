# Aarogya Target Architecture

## 1. The diagram, adapted to what actually exists

```
                         AAROGYA PLATFORM

                                │
                 ┌──────────────┴──────────────┐
                 │                              │
          Identity / IAM                   Tenant Core
     (src/lib/auth/*  — REAL,           (Organization → Facility →
      shared by Scholar +                Department → Ward → Bed —
      Hospital OS; gaps:                 REAL, Hospital OS only;
      no revocation, no                  Scholar's Institution/Cohort
      rate limiting — S-02/S-03)         is a separate, parallel tenancy
                 │                        concept, not yet unified — see §3)
                 └──────────────┬──────────────┘
                                │
                         Clinical Core
                    (Patient/Encounter/Orders/
                     Results/Notes — REAL,
                     Hospital OS only)
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                      │
      Encounters              Orders             Longitudinal
    (REAL: OPD/ED/IPD/    ┌─────┼─────┐            Record
     Daycare/Tele)        │     │     │        (REAL: the patient
          │              Lab Imaging  Rx        chart API — the one
          │            (REAL)(REAL) (REAL,      place all of this is
          │                          narrow)     actually queried together)
          │                     │
          └─────────────────────┼──────────────────────┐
                                │                        │
                       Operational Core          [MISSING: Procedures
                    (Beds/Admissions/Staff        — no OT module yet]
                     — REAL, transactional)
                                │
          ┌─────────────────────┼─────────────────────┐
          │                     │                      │
        Beds                Nursing                 Tasks
    (REAL: state          (PARTIAL: task         (MISSING as a
     machine + audit       engine works as a       first-class entity
     trail)                 computed view, not      — see Target
                             a real Task table)      Domain Architecture §2.3)
          │                     │                      │
          └─────────────────────┼──────────────────────┘
                                │
                         Financial Core
                        (Charges/Bills — REAL,
                         narrow; Payments MISSING)
                                │
                        Billing / Insurance
                     (Billing PARTIAL, Insurance
                      entirely MISSING)
                                │
                        Intelligence Layer
                  ┌──────────────┼──────────────┐
                  │              │              │
              Alerts          Events           AI
          (REAL, deter-   (ARCHITECTURE     (REAL for Scholar
           ministic,       ONLY — see        only; MISSING for
           see §4)         EVENT_ARCHITECTURE) Hospital OS)


        ═══════════════════ SEPARATE, PARALLEL ═══════════════════

              Aarogya Scholar                Original Prototype
         (own Institution/Cohort         (Patient/Doctor/Hospital/Admin
          tenancy, own case engine,       — entirely client-side Zustand,
          shares only Identity Core       zero shared infrastructure with
          with Hospital OS — REAL,        either real system — see
          full domain, see                docs/SECURITY_AUDIT.md S-01)
          STUDENT_PLATFORM_
          ARCHITECTURE.md)
```

## 2. What this diagram corrects relative to the brief's original sketch

The brief's illustrative diagram assumed one unified platform. The
**actual** architecture today is three parallel systems sharing only the
Identity Core (and even that only partially — Scholar's `Institution`
tenancy and Hospital OS's `Facility` tenancy are structurally different
and not linked; the original prototype shares *nothing*, not even
`User`). This is the single most important correction Phase 0 produces:
**the target diagram is aspirational, the current reality has three
islands**, and the roadmap (`docs/IMPLEMENTATION_ROADMAP.md`) is
sequenced around closing that gap deliberately rather than pretending it
doesn't exist.

## 3. The specific unification problem: two tenancy models

Scholar: `Institution → (implicitly) Student`. No `Facility`/`Department`/
`Ward`/`Bed` concept — a teaching institution isn't a hospital facility in
Scholar's model, deliberately (a student's institution and the hospital
they might eventually work at are different things).

Hospital OS: `Organization → Facility → Department → Ward → Bed`. No
`Institution`/`Cohort` concept.

**These should NOT be merged into one tenancy model** — a medical college
and a hospital facility are genuinely different kinds of tenant, and
forcing them into one hierarchy would create exactly the kind of
"everything is one giant application" anti-pattern the brief itself warns
against (§200 of the Hospital OS brief: "Aarogya should not become one
giant application. It should become a platform."). The correct target
(see `docs/CORE_PLATFORM_ARCHITECTURE.md`'s Identity/IAM section) is:
**one shared Identity Core, multiple independent tenancy models**, which
is architecturally what exists today — it just hasn't been named and
documented as the intentional target until now.

## 4. Where Scholar and Hospital OS should eventually connect (and shouldn't, elsewhere)

**Should connect** (brief §106-107, "Teaching Hospital" — not built this
phase, see `docs/MASTER_GAP_MATRIX.md`): a `HospitalStaffProfile` should
be able to also hold an `EDUCATOR` capability, and a teaching hospital's
`Facility` should be able to host Scholar `Cohort`s and rotations, with
students seeing **only the authorized educational representation** of
real cases (via the exact `ClinicalCaseProvider`/`caseSanitizer.ts`
pipeline Scholar already built for synthetic cases — see
`docs/CLINICAL_EDUCATION_PRIVACY.md` §8's core principle: "Student Case ID
≠ Clinical Patient ID"). This is Phase 9 work (Interoperability/AI phase)
in the roadmap, deliberately late — it depends on Hospital OS's Clinical
Core being mature enough to have real cases worth de-identifying.

**Should NOT connect**: student accounts should never gain any
`Facility`-scoped permission (`patient:write`, `clinical:order:*`,
`admission:*`, `billing:*`) — verified as already true today
(`docs/SECURITY_AUDIT.md`'s clean-verification list: `STUDENT` holds none
of Hospital OS's operational permissions). This boundary must be
preserved, not loosened, as the two systems grow closer.

## 5. The unification target for the original prototype

Per `docs/SECURITY_AUDIT.md` S-01 and
`docs/IMPLEMENTATION_ROADMAP.md` Phase 1: the original Patient/Doctor
experience should migrate onto Hospital OS's real `Patient`/`Encounter`
model and Identity Core's real session system, **not** get its own third
parallel backend. A "patient" logging into the Patient/Doctor prototype
in the target state is a `Role.PATIENT` user (already in the enum, unused
today — see `docs/DATA_MODEL_AUDIT.md` §1) whose data comes from the same
`Patient`/`Encounter` tables a hospital's `DOCTOR` role writes to — this
is what makes "one authoritative clinical backend" (the brief's stated
goal) actually true, rather than three backends that happen to use
similar names.
