# Patient Flow — Phase 2

Turns Hospital OS's Phase-1 clinical-core foundation into a genuinely
usable Access + Patient Flow + ADT (Admission/Discharge/Transfer) system.
This document is the umbrella reference; `docs/ADT_ARCHITECTURE.md`,
`docs/OPD_WORKFLOW.md`, and `docs/EMERGENCY_WORKFLOW.md` go deeper on
their specific areas.

## 1. What Phase 2 explicitly did NOT rebuild

Per the brief's explicit instruction, every request/reservation/queue
layer built this phase sits **on top of** the existing, working,
transactional machinery from Phase 0/1 — none of it was duplicated:

- `src/lib/hospital/bed.ts`'s legal bed-state-transition table and
  `transitionBed()` — extended with an optional transaction-client
  parameter so Phase 2's reservation flows can compose it into their own
  atomic operations, but the transition rules themselves are untouched.
- `src/lib/hospital/admission.ts`'s `admitPatient()`/`transferPatient()` —
  relaxed to also accept a bed already `RESERVED` by the request that's
  confirming/completing (previously only `AVAILABLE`), otherwise
  identical to Phase 0's original logic.
- The `EncounterStatus` enum and `encounterStateMachine.ts`'s legal
  transitions (Phase 1) — untouched; triage now also transitions
  `REGISTERED → TRIAGED` through the same controlled service.
- `Discharge`'s six readiness flags — untouched; Phase 2 adds a computed
  barrier engine and expected-date tracking on top, not a replacement.

## 2. The patient-flow model

```
ACCESS            Appointment / Walk-in / Referral / Emergency / Follow-up
      ↓
ARRIVAL           Registered → Checked-in → Waiting (Appointment.status / Encounter)
      ↓
CLINICAL ACCESS   Triage → Queue → Consultation (TriageAssessment, QueueEntry, Encounter)
      ↓
DISPOSITION       Continue OPD / Investigations / Observation / Admission / Transfer / Referral / Discharge
      ↓
POST-VISIT        Follow-up / Closed encounter
```

Every transition is traceable through real timestamps on `Appointment`,
`QueueEntry`, `TriageAssessment`, `Encounter`, `AdmissionRequest`,
`TransferRequest`, and `Discharge` — aggregated into one operational
timeline per visit by `src/lib/hospital/patientFlowTimeline.ts`
(`GET /api/hospital/encounters/[id]/flow-timeline`), distinct from Phase
1's patient-level *clinical* timeline (`src/lib/patient/timeline.ts`),
which aggregates diagnoses/notes/orders across the whole longitudinal
record instead of one visit's operational movement.

## 3. New database models

`Appointment`, `DoctorScheduleBlock`, `QueueEntry`, `TriageAssessment`,
`EncounterLocation`, `AdmissionRequest`, `TransferRequest`, `SlaPolicy` —
plus nullable arrival/access fields added directly to `Encounter`
(`accessSource`, `arrivalMode`, `traumaIndicator`, `ambulanceRef`,
`accompanyingPerson`, `referringProviderName`, `referringFacilityName`,
`referralUrgency`) and three fields added to `Discharge`
(`initiatedByStaffId`, `expectedDischargeAt`, `expectedDischargeReason`).

**Deliberately not built as new tables** (brief's own §9 "Use the existing
event architecture," §48/§58 patterns, and this repo's established
computed-aggregation precedent, `docs/CLINICAL_CORE.md` §4):

- **`PatientFlowEvent`** — the operational timeline is computed at request
  time from the tables above, the same pattern as the Phase 1 clinical
  timeline. A duplicated event table would be a second source of truth
  that could drift from the state it's supposedly describing.
- **`OperationalAlert`** — SLA-breach alerts are new rule functions added
  to the existing `src/lib/hospital/alertEngine.ts`, computed live on
  every Command Center load, not persisted. Same reasoning as the
  existing critical-lab/bed-shortage alerts it already contained.
- **A separate discharge-request wrapper model** — the existing
  `Discharge` model already captures readiness/summary/sign-off; Phase 2
  extends it with `initiatedByStaffId`/expected-date fields rather than
  wrapping it in a new "DischargeRequest" entity.

## 4. Queue priority — deterministic, never an AI judgment call

`src/lib/hospital/queue.ts`'s `computeQueuePriority()` is a fully
explicit, unit-tested arithmetic function (brief §9's explicit
instruction: "do not hard-code medical triage decisions as AI"):

| Factor | Effect |
|---|---|
| ED/emergency arrival | −40 |
| Marked EMERGENCY / URGENT priority | −30 / −15 |
| Recorded triage acuity (1–5) | dominates — `score = min(score, acuity × 10)` |
| Age under 2 or 75+ | −5 |
| Wait > 30 min | anti-starvation bonus, up to −20, capped |

Lower score is seen sooner. Every non-trivial factor is recorded in
`QueueEntry.priorityReason` — the queue is never silently reordered
without a recorded reason (brief §23).

## 5. Concurrency

- **Appointment double-booking** (brief §61): `bookAppointment()` runs a
  transactional check-then-create — counts existing active appointments
  at the exact requested `scheduledStart` against the doctor's
  `DoctorScheduleBlock.maxConcurrentAppointments` (default 1), inside the
  same `$transaction` as the insert. Live-verified: a second booking
  attempt at an already-full slot is rejected with a 400.
- **Bed reservation / admission concurrency** (brief §62-63): reservation
  reuses the existing `transitionBed()` legal-transition check
  (`AVAILABLE → RESERVED`) inside a `$transaction` — a second concurrent
  reservation attempt on the same bed sees it already `RESERVED` and is
  rejected (`Illegal bed transition: RESERVED -> RESERVED`), live-verified
  by racing two admission requests for the same bed.
- **Caveat**: this is an application-level transactional check, not a
  database row lock. SQLite serializes `$transaction` calls against its
  single connection, which makes this genuinely safe at dev/demo
  concurrency. A Postgres deployment under real concurrent write load
  should additionally take a `SELECT ... FOR UPDATE`-style lock or a
  partial unique index — noted as a Phase 3+ hardening item, not
  silently assumed safe at production scale.
- **Duplicate active admission** is structurally impossible:
  `Admission.encounterId` is `@unique` (Phase 0), so a second admission
  attempt on an already-admitted encounter fails at the database level
  regardless of application logic.

## 6. Permissions added this phase

`patient:checkin`, `appointment:create/update/cancel`, `queue:manage`,
`triage:record`, `encounter:assign`, `admission:request/approve/allocate`,
`transfer:request/approve/execute`, `discharge:approve`, `bed:reserve`.
All checked server-side via the existing `requireFacilityStaff()`
tenant-scoping helper — no new authorization mechanism.

One new `Role`: `FRONT_DESK` — the only genuinely new persona (brief §66
explicitly allows reusing `NURSE`/`DOCTOR`/`HOSPITAL_ADMIN` with a
department/displayRole for triage nurse / emergency doctor / bed manager,
since none of those need a distinct permission set).

## 7. What Phase 2 deliberately left out

Per the brief's own scope boundary and its "do not build Phase 3"
instruction: no formal ticket-number queue display (priority-ordered
position only), no ambulance real-time integration (data-capture fields
only — brief §47's "interface for future integration"), no notification
delivery (SMS/push) for alerts, no command palette (brief §71 said
"consider," not "build" — a real gap, not a rejection, listed as a Phase
3 prerequisite), no full escalation/department-lead chain (alerts
surface an `ownerRole` and severity, not a multi-step escalation
workflow — building department-lead assignment and paging is genuinely
Phase 3+ territory). See the Phase 2 final report's REMAINING GAPS for
the complete list.
