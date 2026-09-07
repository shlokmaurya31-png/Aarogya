# Phase 5.5 — Cross-Module Integrity + Concurrency Gate

Not a feature phase. Run in a fresh context specifically to re-verify
Phases 1–5 with independent skepticism before Phase 6 (any new large
clinical subsystem) starts. Starting commit: `a1da0f2` (`feat(hospital-os):
implement billing, insurance, and revenue cycle`), `origin/main` in sync,
clean tree, confirmed before any work began.

## Repository

- Branch `main`, HEAD `a1da0f2`, matches `origin/main`, tree clean at
  session start.
- No history rewritten, no prior approved work reset.

## Baseline (before any change)

`prisma validate` clean · `prisma generate` clean · `tsc --noEmit` clean ·
`vitest run` 231/231 (pre-existing Phase 1–5 suite; the number quoted in
Phase 5's own docs was measured earlier in that phase before its own final
additions) · `npm run lint` 3 errors / 18 warnings, all in
pre-existing unrelated files (`AiAssistantPanel.tsx`, `TopBar.tsx`, an
Android build artifact, `DashboardHero.tsx`, `saa-s-template.tsx`) · `npm
run build` succeeds. Re-confirmed by temporarily removing this gate's new
`appointment.test.ts` and re-running the suite (231/231), then restoring
it (240/240) — see "Final Test Counts".

## Scope calibration — what this gate did and didn't do

Per the brief's own "verify rather than duplicate" instruction and Fix
Policy, effort was concentrated where direct file reads turned up genuine,
previously-unproven defects, rather than re-deriving work Phase 5 already
documented and verified against real Postgres concurrency
(`docs/PHASE_5_FINANCIAL_INVARIANTS.md`'s 6 mechanisms: Charge/Payment/
Invoice/Refund/Tariff/Claim — all re-read and treated as verified, not
rebuilt). Full-depth, direct-file-read audits were completed for: bed
lifecycle, appointment booking, admission/transfer/discharge, the Phase 2
admission-request/transfer-request reservation layer, queue call-next,
facility isolation (all 74 dynamic hospital routes), RBAC + facility
resolution on every bed/admission/transfer/discharge route, charge-capture
bypass risk, mass-assignment risk, and ID-label confusion in both legacy
and Phase 5 routes. Scoped down to a targeted spot-check rather than a
full rebuild: the complete RBAC permission×role matrix (Phase 5's own
matrix in `src/lib/auth/permissions.ts` was read and spot-checked on the
routes this gate's fixes touch, not independently re-derived for every
permission in the system), the full financial-ledger re-derivation (Phase
5's own worked example and invariant table were verified as internally
consistent and Postgres-tested, not re-run from scratch), a formal
adversarial fuzzing pass, and a systematic performance/query audit (no
correctness-critical N+1 or unbounded-query issue was found in the files
read, but this was not an exhaustive sweep of every route).

## Bugs found

| # | Symptom | Root cause | Impact | Fix | Regression test |
|---|---|---|---|---|---|
| 1 | Two concurrent admissions/transfers/reservations could both claim the same physical bed | Every bed-status mutation read `bed.status`, checked legality in app code, then wrote with an **unconditional** `update()` — classic TOCTOU, the exact anti-pattern the brief calls out | High — physical bed double-occupancy, corrupted audit trail, patient-safety-adjacent | Converted all 7 call sites (`bed.ts#transitionBed`, and `admission.ts`'s `admitPatient`/`transferPatient`×2/`finalizeDischarge`/`completeBedCleaning`) to the codebase's established guarded-`updateMany`+count-check idiom (`BedConcurrencyError` on loss); `completeBedCleaning` additionally wrapped in a transaction (previously two un-transacted calls) | `scripts/verify-postgres-bed-concurrency.ts` — 3 genuine-parallel scenarios (admitPatient, transferPatient, allocateBed via the Phase 2 reservation layer), 6/6 assertions pass on real Postgres |
| 2 | A doctor could be double-booked for overlapping appointment times | Conflict check compared `scheduledStart` for **exact equality only**, ignoring `scheduledEnd` entirely — partial overlaps were invisible | High — ticket-flagged, confirmed; scheduling collision, doctor/patient time conflict | Real half-open-interval overlap query (`lt`/`gt` on `scheduledStart`/`scheduledEnd`), scoped to `doctorStaffId` (the actual resource — `roomLabel` is informational, not separately reservable on this schema) | `appointment.test.ts` — 9-case pure-function overlap matrix (exact duplicate, partial start/end, contained, containing, adjacent×2, disjoint, reschedule-into-conflict); `scripts/verify-postgres-appointment-concurrency.ts` — 7 scenarios including a genuine parallel race, 7/7 pass |
| 3 | Postgres could theoretically still race two concurrent bookings for the same doctor (phantom-read: both see zero overlapping rows before either commits) | An app-level count-then-insert check alone cannot close a phantom-read race under concurrent transactions | High if untreated — would have undermined bug 2's fix under real concurrent load | `pg_advisory_xact_lock` keyed on `doctorStaffId`, taken at the top of `bookAppointment`'s transaction (Postgres only, no-op on SQLite where `$transaction` is already serialized by the single-connection lock). **Rejected alternative**: a GiST exclusion constraint (used for ImagingStudy/Tariff) — rejected because `maxConcurrentAppointments` is a real, API-exposed, admin-configurable value that can legitimately exceed 1, and a static per-table exclusion constraint cannot express a bound read from a joined `DoctorScheduleBlock` row; a hard 1-row constraint would have incorrectly rejected legitimate multi-slot clinic sessions | Same `scripts/verify-postgres-appointment-concurrency.ts` — includes a same-doctor genuine-parallel race (exactly 1 winner) and a different-doctor genuine-parallel race (both must commit, proving the lock doesn't over-serialize) |
| 4 | The `confirm` appointment action bypassed the entire service layer | Route did a bare, non-transactional, non-audited `prisma.appointment.update()`, unlike every sibling action (`cancel`/`noShow`/`checkIn`) | Medium — no audit trail for confirmations, no concurrency guard, inconsistent with the rest of the module | New `confirmAppointment()` service function: transactional, guarded `updateMany` on observed status, records `hospital.appointment.confirmed` | Route now delegates identically to the other three actions; covered by the existing route test surface (no dedicated new test needed — mirrors `cancelAppointment`'s already-tested shape) |
| 5 | A one-off `DoctorScheduleBlock.specificDate` override almost never matched | Compared a date-only column against a full `Date` timestamp with time-of-day, via JS `Date` equality | Low — silent no-op, one-off schedule overrides never took effect | Range-matched (`gte`/`lt` day bounds) + calendar-date comparison, mirroring the already-established idiom in `doctorSchedule.ts` | Covered incidentally by the overlap-matrix tests exercising `bookAppointment`'s block-lookup path |
| 6 | Two concurrent "call next patient" requests could both call the same WAITING queue entry | `findFirst` + unconditional `update()` inside one transaction — same TOCTOU class, lower severity (terminal-state churn, not physical-resource corruption) | Low-Medium — duplicate "called" audit events, two staff/rooms believing they called the same patient | Guarded `updateMany` on observed status, bounded retry (5 attempts) against the next candidate on a lost race | `scripts/verify-postgres-queue-concurrency.ts` — genuine parallel race, 3/3 assertions pass (exactly one caller wins, exactly one audit event) |

## Deliberately deferred (found, not fixed — reported per the brief's STOP-and-report instruction)

**Lab/imaging order duplicate-submission window.** `orders/lab/route.ts`
and `orders/imaging/route.ts` use a 15-second `findFirst`-based duplicate
check with no DB-level backstop — genuinely TOCTOU under true parallel
requests (two requests could both pass the `findFirst` before either
commits). Checked `docs/PHASE_4_DIAGNOSTICS_ARCHITECTURE.md` §12.6-12.7
directly: this *is* the documented, intentional fix for a worse prior bug
(comparing against a freshly-generated `sourceId` that could never match),
and the doc's "HARDENED" claim there is specifically about `Charge`
idempotency (`@@unique([sourceType, sourceId])`, confirmed present in
schema), not order-row creation itself — so this is a real, previously
undocumented-as-such residual gap, not a misunderstanding of an already-
closed issue. A correct fix needs a client-supplied idempotency key
(mirroring `Payment`/`Refund`'s `idempotencyKey @unique` pattern), which
requires UI changes to thread the key through order placement — larger
than a same-file guarded-update fix and outside this gate's "fix what's
found, don't redesign" mandate. Listed below as Must-fix-before-production.

## Appointment integrity (ticket-flagged focus area)

Invariant determined by direct investigation, not assumed: the doctor is
the sole enforced resource (`roomLabel` is informational, drawn from the
matching `DoctorScheduleBlock` at booking time, not itself a reservable
resource on this schema). Overlap defined as genuine half-open-interval
intersection, tested against the full matrix the brief specified: exact
duplicate, partial overlap (start and end), contained, containing,
adjacent (not a conflict), disjoint, different doctor, cancelled/no-show
(excluded), reschedule-into-conflict shape. Concurrency closed via
Postgres advisory-lock serialization (see Bug 3 above for why an exclusion
constraint was the wrong mechanism here), verified with a genuine parallel
race against real Postgres — exactly one booking commits, the other gets
a clean `SlotConflictError` → 400, no duplicate row, no uncaught error,
no phantom success. SQLite relies on `$transaction`'s existing single-
connection serialization (documented, same honest-gap framing as
Tariff/pre-4.5-ImagingStudy).

## Bed / admission-transfer integrity (new finding, not ticket-flagged)

The most severe finding of this gate. Traced every bed-status mutation in
the codebase (7 call sites across `bed.ts` and `admission.ts`) and
confirmed all shared the same unconditional-write TOCTOU. Confirmed the
shared `transitionBed()` helper's fix propagates for free to its 5
downstream callers in the Phase 2 admission-request/transfer-request
reservation layer (`admissionRequest.ts#allocateBed/releaseReservation/
cancelRequest`, `transferRequest.ts#reserveBedForTransfer/
cancelTransferRequest`) by direct read of both files. Verified with 3
genuine-parallel-race scenarios against real Postgres: concurrent
`admitPatient` for the same bed, concurrent `transferPatient` into the
same destination bed, and concurrent `allocateBed` for the same bed via
the Phase 2 layer — all confirm exactly one winner, zero corruption.

## Financial integrity

Not rebuilt from scratch this gate — Phase 5's own concurrency mechanisms
(Charge `@@unique`+atomic insert, Payment `idempotencyKey`+allocation CAS,
Invoice guarded transition+sequence CAS, Refund `idempotencyKey`+CAS,
Tariff GiST exclusion constraint, Claim guarded `updateMany`) were each
re-read directly from `docs/PHASE_5_FINANCIAL_INVARIANTS.md` and the
underlying service files, and are internally consistent with what those
files implement. No new financial-integrity defect was found during this
gate's targeted spot-check of charge-creation bypass risk (0 matches for
any `charge.create()` outside the centralized billing service), mass-
assignment risk (0 matches for spread-body patterns in hospital routes),
and provenance-chain correctness (Charge→InvoiceLine→ClaimLine FK chain
confirmed unbroken per Phase 5's own worked example).

## Security (facility isolation, RBAC, ID-label confusion)

Facility isolation: confirmed clean across all 74 dynamic hospital API
routes (fetch-then-compare `resource.facilityId !== facilityId` pattern
applied consistently). RBAC: spot-checked every route this gate's fixes
touch (`admissions`, `admissions/[id]/transfer`, `beds/[id]/clean`,
`beds/[id]/transition`) — all correctly resolve `facilityId` server-side
via `requireFacilityStaff` and re-verify resource ownership before
mutating; no gaps found. ID-label confusion: re-checked Phase 5's own new
routes (`claims/[id]/*`, `payments/refunds/[id]/*`) plus the routes
touched this gate — all use the right entity for the right lookup.

## Audit consistency

Every route this gate touched already records `facilityId`/`patientId`/
`encounterId` correctly on its audit events (verified by direct read, not
inferred from route naming). The `confirm` appointment action previously
recorded **no** audit event at all — now fixed as part of Bug 4, closing
a real audit gap alongside the concurrency fix.

## PostgreSQL validation

Isolated, throwaway `postgres:16` Docker container (`aarogya-postgres-
phase55`, port 5434 — distinct from the pre-existing unrelated
`onmyway-postgres` container on port 5432, which was never touched),
created fresh for this gate and torn down afterward. Procedure matched
Phase 4.5/5's established convention exactly: `prisma/schema.prisma`'s
provider temporarily flipped to `postgresql`, the existing (unchanged —
this gate made no schema.prisma changes) `migrations-postgres-baseline/`
folder swapped in for `prisma migrate deploy` (all 4 prior migrations
applied cleanly to the fresh database), `prisma generate`, `npm run
db:seed` (succeeded, full Phase 1–5 seed data), then all three new
`verify-postgres-*.ts` scripts run with genuine `Promise.all` parallelism:

- `verify-postgres-bed-concurrency.ts` — 6/6 assertions pass
- `verify-postgres-appointment-concurrency.ts` — 7/7 assertions pass
- `verify-postgres-queue-concurrency.ts` — 3/3 assertions pass

Provider reverted to `sqlite`, migrations folders swapped back, client
regenerated, full SQLite suite re-run to confirm a clean revert (see Final
Test Counts). Container stopped and removed.

## SQLite validation

Every fix runs identically on SQLite (the guarded-`updateMany` idiom and
the interval-overlap query are both plain, portable SQL; the
`pg_advisory_xact_lock` call is explicitly skipped via a `DATABASE_URL`
provider check, since SQLite's `$transaction` calls are already
serialized against its single connection — documented in
`bookAppointment`'s docstring, not silently assumed). Full local suite
(`prisma validate`/`generate`, `tsc --noEmit`, `vitest run`, `lint`,
`build`) re-run after the Postgres revert with identical clean results.

## Remaining risks

**Must fix before production:**
- Lab/imaging order duplicate-submission window (see "Deliberately
  deferred" above) — needs a client-supplied idempotency key threaded
  through order placement, a UI-touching change out of this gate's scope.

**Should fix before Phase 6:**
- `checkInAppointment` (`appointment.ts`) creates a new `Encounter` when
  none exists yet, without a guarded check-then-act on `encounterId` —
  two concurrent check-ins on the same appointment could each create an
  encounter, with the last write winning on `appt.encounterId`. Lower
  severity than the fixed bugs (duplicate encounter row, not resource
  corruption) and outside this gate's approved fix list; noted here so
  it isn't rediscovered from scratch.
- A full RBAC permission×role matrix was not independently re-derived
  from first principles this gate (see Scope calibration) — worth a
  dedicated pass before a much larger Phase 6 subsystem adds new roles or
  permissions.

**Infra blockers:** none newly identified this gate (Phase 4.5/5 already
closed the prior Postgres-readiness blockers).

**Future feature work (explicitly out of scope, not started):** no
`rescheduleAppointment` function was added (reschedule is currently
cancel+rebook, unchanged); no doctor-leave/holiday conflict enforcement
was added; no ICU/OT/Blood Bank/Inventory/Procurement/HR/Workforce/
Facilities/PACS/HL7/FHIR/ABDM/AI clinical decision support work was
started, per the brief's explicit Critical Stop Rule.

## Final test counts

- Vitest: 231 → 240 (added 9 new `appointment.test.ts` overlap-matrix
  cases; all pre-existing 231 continue to pass unchanged).
- New Postgres concurrency scripts: 3 files, 16 assertions, 16/16 passing
  against a real Postgres 16 instance with genuine parallel execution.
- Lint: 3 errors / 18 warnings, identical to baseline, zero in any file
  this gate touched.
- Build: succeeds, identical to baseline.
