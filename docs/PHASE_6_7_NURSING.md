# Phase 6.7 — Nursing Core

## 1. Scope

Nursing Core only: NursingAssessment (new), nursing flowsheet, real vitals/I-O UI, Task-completion concurrency, NursingAssignment concurrency, ClinicalNote sign/amend concurrency, ClinicalHandoff acknowledgement concurrency + a real handoff workflow, CarePlanIntervention/Task linking, RBAC/audit/facility-isolation for all of the above, and surfacing the previously-fetched-but-unrendered nursing data in Patient Chart and Doctor Workspace. Explicitly out of scope and not built: ICU, OT, Blood Bank, advanced diagnostics, ABDM, NHCX, FHIR, DICOM/PACS, telemedicine, microservices/Kubernetes, or any general workflow-engine rewrite.

## 2. Baseline

Starting commit `45bb81d` (branch `main`, on top of Phase 6.6's `fea0d01`, in sync with `origin/main`, clean tree). No Phase 6.7 audit or plan artifact existed anywhere in the repo, git history, or prior session memory — this phase's plan was produced fresh from direct inspection of the current schema/services/routes/components (three parallel `Explore` passes), not inherited from an untraceable prior session. `vitest run`: 274/274 passing (35 files) before any change.

## 3. Findings (independently verified against the actual code before any fix was designed)

- **NursingAssignment "one active per patient"**: already the real, intended invariant — `assignNurse()` already ended all open assignments before creating a new one, transactionally. Not backed by a DB constraint, so two truly concurrent `assignNurse` calls could each end the same stale row and both create a new active row.
- **Task completion**: `tasks/[id]/route.ts` PATCH did a plain `prisma.task.update()` — no transaction, no status guard, no transition validation (even `COMPLETED -> OPEN` was silently allowed).
- **ClinicalHandoff acknowledgement**: `acknowledgeHandoff` did `findUniqueOrThrow` → status check → plain `update()` — the exact check-then-act TOCTOU shape Phase 6.6 fixed for medication administration, just never retrofitted here.
- **ClinicalNote sign/amend**: sign had an app-level status check but no `updateMany` guard; amend did two un-transacted writes (supersede the old note, then create the new one) with no status guard on the supersede and no verification that `supersedesId` actually belonged to the same encounter — a real cross-encounter IDOR gap, not just a race.
- **CarePlanIntervention**: `completeIntervention(interventionId)` never verified the intervention belonged to the `carePlanId` in the URL — any staff at the facility could complete an intervention belonging to a different care plan (and therefore potentially a different patient) by supplying an arbitrary id. No relation to `Task` existed at all.
- **Intake/Output**: the POST route recorded a real `IntakeOutputRecord` but audited it as `"hospital.vital.recorded"` — the wrong event type; no `hospital.io.recorded` type existed. It also derived `recordedByStaffId` as `staff?.id ?? session.userId`, which on the `staff === null` path silently stored a `User.id` in a column meant to hold a `HospitalStaffProfile.id`, corrupting provenance. The same bug existed in the vitals POST route.
- **Vitals UI**: `NurseTasks.tsx`'s "Record vitals" button posted the literal hardcoded payload `{hr:78, sbp:120, dbp:80, rr:16, spo2:97, tempC:37.0}` for every patient, every click — confirmed, not assumed.
- **Handoff creation UI**: both call sites (`NurseTasks.tsx`, `PatientChart.tsx`) used `window.prompt("Handoff summary?")` and only ever populated `summary`, even though the schema/API already support `urgency`, `activeProblems`, `pendingInvestigations`, `pendingMedications`, `pendingTasks`, `safetyConcerns`, `escalationRequired`. No handoff acknowledge UI existed anywhere despite `GET`/`PATCH /api/hospital/handoffs` being fully implemented server-side.
- **Patient Chart**: fetched `vitals` and `handoffs` from the chart API but never rendered either (`handoffs` wasn't even in the `ChartData` TypeScript interface).
- **Doctor Workspace**: fetched and server-computed `followUpTasks`/`pendingHandoffs` but never rendered either tile.
- **`clinical:note:sign` permission**: declared in the permission catalog and granted to `DOCTOR`, but the actual sign route checked `clinical:note:create` instead — which `NURSE` already held, so nurses could already sign notes today, just through an unintended/undocumented path.

## 4. Fixes

**Concurrency (guarded-`updateMany` CAS idiom — reused, not reinvented, from `bed.ts`/`purchaseOrders.ts`/Phase 6.6's `medicationLifecycle.ts`)**:
- `src/lib/hospital/task.ts` (new): `completeTask`/`skipTask`/`updateTask`, each guarding on `status: { notIn: ["COMPLETED", "CANCELLED"] }`. `TaskConcurrencyError`.
- `src/lib/hospital/clinicalNote.ts` (new): `signNote` (guarded `DRAFT -> SIGNED`) and `amendNote` (transaction: guarded `SIGNED -> SUPERSEDED` on the old note, then create the replacement, both atomic — closes both the race and the un-transacted-writes bug). `NoteConcurrencyError`. Also verifies `supersedesId`'s note belongs to the same encounter (closes the cross-encounter IDOR).
- `src/lib/hospital/handoff.ts` (modified): `acknowledgeHandoff` now guards `status: "PENDING"` in the `updateMany`. `HandoffAlreadyAcknowledgedError` now extends `BadRequestError`. Both `createHandoff`/`acknowledgeHandoff` audit events now carry full `{facilityId, patientId, encounterId}` context (previously missing).
- `src/lib/hospital/nursingAssignment.ts` (modified): `endAssignment` now guards `endAt: null` in the `updateMany`. `assignNurse` relies on the new DB-level partial unique index and catches the resulting `P2002` to throw `NursingAssignmentConcurrencyError` instead of allowing a silent duplicate-active-assignment or leaking a raw constraint error.
- `src/lib/hospital/nursingAssessment.ts` (new): full `createAssessment`/`completeAssessment`/`signAssessment`/`amendAssessment` lifecycle, each transition guarded the same way. `amendAssessment` guards the old row on `status: "SIGNED", isCurrent: true` together (both conditions needed — guarding on status alone would let two concurrent amendments each supersede the same row and each create a "current" replacement).
- `src/lib/hospital/carePlan.ts` (modified): `completeIntervention` now verifies `intervention.carePlanId === input.carePlanId` before mutating (closes the IDOR), and — if the intervention has a linked `taskId` — completes that Task transactionally in the same guarded idiom, so the intervention and its task can never end up in an inconsistent dual state.

**Facility isolation / IDOR**: `POST /api/hospital/nurse/assignments` now validates `patientId` (previously unchecked), `encounterId` (must belong to that patient), and `bedId` against the caller's facility before assigning. `POST /api/hospital/handoffs` now validates `toStaffId` against the facility. `POST/PATCH /api/hospital/encounters/[id]/vitals` and `.../io` now require a resolved `staff` (reject with 400 rather than silently writing a `User.id` where a `HospitalStaffProfile.id` is expected) and record `recordedByStaffId: staff.id` directly.

**Audit**: extended `AuditEventType` with `hospital.io.recorded`, `hospital.nursing.assessmentCreated/Completed/Signed/Amended`, `hospital.carePlan.interventionCreated/Completed`. Fixed the I/O route to emit `hospital.io.recorded` instead of `hospital.vital.recorded`.

**RBAC**: added `nursing:assessment:create`/`nursing:assessment:sign`, granted to `NURSE` only. Wired the previously-unused `clinical:note:sign` into the sign route (PATCH now checks `clinical:note:sign` instead of `clinical:note:create`) and granted it to `NURSE` in addition to `DOCTOR` — preserves current nurse capability exactly while closing the catalog/enforcement drift. No grants added to `FRONT_DESK`/`BILLING_STAFF`/`PHARMACIST`.

**New backend surfaces**:
- `POST/PATCH /api/hospital/encounters/[id]/nursing-assessment` (+ `GET` for current/history) — facility/patient/encounter always derived server-side from the URL's encounter, never from client body.
- `GET /api/hospital/encounters/[id]/flowsheet` — `src/lib/hospital/flowsheet.ts`'s `buildFlowsheet()` is a **read-only composition layer**: it aggregates existing `Vital`/`IntakeOutputRecord`/`MedicationAdministration`/`Task`/`CarePlanIntervention` rows into one timestamp-sorted array with `{type, timestamp, actorStaffId, summary, refId}`. No new table; every entry links back to its canonical source row.
- `GET /api/hospital/tasks` gained an `encounterId` filter (needed by the new nursing workspace; previously only `status`/`ownerStaffId`).
- `GET /api/hospital/handoffs` gained a `patientId` filter (needed by the patient-scoped handoff inbox).

**Frontend**: `NurseTasks.tsx`'s vitals button is now a real form (six numeric fields, submits actual entered values); added an inline I/O entry panel per assigned patient; added a collapsible handoff inbox (`toStaffId`-scoped) and replaced `window.prompt` handoff creation with the new `HandoffComposer` (urgency, addressee-free summary, active problems, pending investigations/medications/tasks, safety concerns, escalation checkbox — every field the schema already supported but no UI collected). New `NursingWorkspace.tsx` + route `/hospital-os/nurse/patients/[id]` — an encounter-scoped workflow surface (assessment lifecycle, vitals, I/O, flowsheet, tasks, care-plan interventions, MAR summary with a pointer to My Shift for actual administration, handoffs, notes) — not a second dashboard, one practical clinical workflow reusing the codebase's established skeleton/toast/empty-state conventions. `PatientChart.tsx`: fixed the `handoffs`-fetched-but-unrendered gap via a new `HandoffInbox` card, added a Vitals card, replaced both remaining handoff/`window.prompt` sites with `HandoffComposer`, and replaced the note-amendment `window.prompt` with a proper inline reason field. `DoctorWorkspace.tsx`: `followUpTasks` and `pendingHandoffs` are now rendered tiles, with the handoffs tile toggling a compact `HandoffInbox`.

**Deliberately left untouched** (named `window.prompt` sites outside Nursing Core's explicit scope, documented rather than silently expanded into): admission-rejection reason (`AdmissionsWorklist.tsx`), discharge-date-change reason (`DischargeCenter.tsx`), pharmacy danger-override reason (`PharmacyWorkspace.tsx`), medication held/refused reason (`NurseTasks.tsx`).

## 5. Schema

New `NursingAssessment` model (`facilityId, patientId, encounterId, nurseStaffId, status ("DRAFT"|"COMPLETED"|"SIGNED"|"SUPERSEDED"), version, isCurrent, previousVersionId, findings (Json), completedAt, signedAt, amendedAt, amendmentReason, createdAt`), mirroring `ClinicalNote`'s versioning shape rather than inventing a new pattern. `findings` is a documentary JSON blob (system-review-style free-text sections: general, neuro, cardiovascular, respiratory, GI, GU, skin, psychosocial, safety) — no scoring system or clinical decision logic implemented or implied.

`CarePlanIntervention.taskId String?` + optional relation to `Task` — nullable, most interventions stay documentary-only.

`NursingAssignment`: a partial unique index — `CREATE UNIQUE INDEX ... ON "NursingAssignment"("patientId") WHERE "endAt" IS NULL` — added by hand in both migration trees (not expressible in `schema.prisma` syntax; same convention as the existing Payer/Tariff exclusion constraints).

Migrations: `prisma/migrations/20260908224702_phase6_7_nursing_core` (sqlite dev, generated via `prisma migrate dev` then hand-extended with the partial index) and `prisma/migrations-postgres-baseline/20260908230000_phase6_7_nursing_core` (hand-mirrored portable SQL). Both are single incremental additions on top of the existing committed history — no historical migration file was regenerated, squashed, or replaced (`git diff --stat` confirmed only new files + the `schema.prisma` model additions).

## 6. Database invariants

- At most one open (`endAt IS NULL`) `NursingAssignment` per patient, enforced at the DB level (previously only application-level).
- A `Task`/`ClinicalNote`/`ClinicalHandoff`/`NursingAssessment` transition out of a terminal-for-that-step state can only ever succeed once per row per call.
- A `NursingAssessment` has at most one `isCurrent: true` row per encounter at any time (enforced by the combined status+isCurrent guard in `amendAssessment`).
- A `CarePlanIntervention` can only be completed once, and if linked to a `Task`, both complete atomically together (never one without the other).

## 7. Concurrency strategy

No new concurrency primitive was introduced. Every fix reuses the codebase's established guarded-`updateMany`-plus-count-check CAS idiom, the same one Phase 6.6 used for medication administration and Phase 4.5/6A used for beds/purchase orders/invoices.

## 8. PostgreSQL race-test results

Disposable `postgres:16-alpine` container (isolated port `55432`, synthetic seed data only, torn down after this run). Both migration trees applied cleanly in order to a fresh database, confirmed via `\d "NursingAssignment"` that the partial unique index landed exactly as written.

| Script | Assertions | Result |
|---|---|---|
| `verify-postgres-nursing-concurrency.ts` (new — Task/Assessment/Assignment/Handoff/Note races + IDOR + task-linked completion) | 8 | 8/8 PASS |
| `verify-postgres-medication-concurrency.ts` (Phase 6.6 regression) | 6 | 6/6 PASS |
| `verify-postgres-appointment-concurrency.ts` (regression) | 7 | 7/7 PASS |
| `verify-postgres-bed-concurrency.ts` (regression) | 6 | 6/6 PASS |
| `verify-postgres-billing-concurrency.ts` (regression) | 13 | 13/13 PASS |
| `verify-postgres-inventory-concurrency.ts` (regression) | 9 | 9/9 PASS |
| `verify-postgres-procurement-concurrency.ts` (regression) | 7 | 7/7 PASS |
| `verify-postgres-queue-concurrency.ts` (regression) | 3 | 3/3 PASS |
| `verify-postgres-scheduling.ts` (regression) | 8 | 8/8 PASS |
| **Total** | **67** | **67/67 PASS** |

Nursing-specific cases (all via `Promise.allSettled` against real service functions on the same row, per this codebase's established convention — never two sequential calls mislabeled as a race):
- **A** — two concurrent `completeTask` on the same task: exactly one succeeds, exactly one `COMPLETED`, exactly one audit event. PASS.
- **B1** — two concurrent `signAssessment` on the same `COMPLETED` assessment: exactly one succeeds, exactly one `SIGNED`. PASS.
- **B2** — two concurrent `amendAssessment` on the same `SIGNED` assessment: exactly one succeeds, exactly one current version afterward. PASS.
- **D** — two concurrent `assignNurse` for the same patient: at most one active assignment afterward — the partial unique index genuinely rejected the loser with `P2002` under a true concurrent race (observed directly in the Postgres error log), converted cleanly to `NursingAssignmentConcurrencyError`. PASS.
- **E** — two concurrent `acknowledgeHandoff` on the same handoff: exactly one succeeds, exactly one `ACKNOWLEDGED`. PASS.
- **F** — two concurrent `amendNote` on the same signed note: exactly one succeeds, exactly one `SUPERSEDED`, exactly one replacement note (no branching history). PASS.
- **IDOR** — `completeIntervention` rejects an `interventionId` belonging to a different `carePlanId`. PASS.
- **Task-linked completion** — completing a linked intervention transactionally completes its `Task`. PASS.

## 9. Security / RBAC results

`permissions.test.ts` extended with a "Phase 6.7 Nursing Core boundary" suite: `NURSE` holds `nursing:assessment:create`/`:sign` and now `clinical:note:sign`; `FRONT_DESK`/`BILLING_STAFF`/`PHARMACIST` hold none of `nursing:assessment:create`, `nursing:assessment:sign`, `nursing:assignment:manage`, `handoff:manage`, `carePlan:manage`, `io:record`, `task:manage`. Every new/modified route derives `facilityId`/`patientId`/`encounterId` server-side via the existing `requireFacilityStaff` convention — no client-supplied id is trusted for scoping.

## 10. Audit verification

New audit event types (§4) fire with full `{facilityId, patientId, encounterId}` context on every nursing mutation. `hospital.handoff.created`/`hospital.handoff.acknowledged` now also carry that context, which they previously lacked. The Postgres race tests confirmed exactly one audit event is recorded per successful Task completion even under genuine concurrency (Case A).

## 11. UI verification

The Chrome browser extension disconnected repeatedly this session (transient, not investigated further), so verification fell back to the same documented contingency Phase 6.6 used: authenticated `curl` against the actually-running dev server (`npm run dev`, real session cookies via `/api/scholar-auth/login`), driving the real API surface end-to-end rather than a mocked one. As `NURSE` (`nurse1@amc-demo.aarogya`): `/hospital-os/nurse` and `/hospital-os/nurse/patients/[id]` both render (200); created a real DRAFT assessment, walked it through `complete -> sign -> amend` (the amendment correctly produced version 2 as the new SIGNED/current row and superseded version 1, exactly matching the designed lifecycle); recorded real non-hardcoded vitals and an intake/output entry, both of which immediately appeared in the flowsheet composition; completed a real task through the guarded service (confirmed a second completion attempt now fails cleanly with 400 "already COMPLETED", not a silent double-success or a raw 500); created a structured handoff (urgency, safety concerns, escalation flag) and acknowledged it. As `BILLING_STAFF`: confirmed 403 `"Missing permission: nursing:assessment:create"` on the same route. As a `DOCTOR` from a **different facility** (Aarogya Noida Hospital): confirmed both new routes (`nursing-assessment`, `flowsheet`) return 404 "Encounter not found" for the AMC encounter, not a 403 (avoiding a resource-existence leak) and not the actual data. As `DOCTOR` (same facility): `/hospital-os/doctor` and the Patient Chart page (now rendering the Vitals/Handoffs cards) both render (200). **Full interactive click-through (form focus/blur, toast timing, responsive layout) was not exercised** since the browser extension was unavailable — the HTTP-level proof above is strong (every new/modified route and lifecycle transition was actually invoked, not just unit-tested) but is not a substitute for an actual browser render if a future session has the tooling available.

## 12. Remaining gaps

**Phase 6.7 remaining gaps**:
- `NursingWorkspace.tsx`'s MAR section is read-only (order list + status); actual administration still happens from `NurseTasks.tsx` ("My Shift") by design (brief §16 — reuse the existing MAR, don't rebuild it), so a nurse working from a specific patient's workspace must switch views to administer a dose.
- The four `window.prompt` sites named in §4 as out-of-scope remain.
- `findings` on `NursingAssessment` has no structured validation beyond "is JSON" — malformed or empty section text is accepted, consistent with `ClinicalNote.content`'s existing precedent, but worth a future pass if data quality issues surface.

**Pre-existing / out-of-scope gaps** (found during this phase's investigation, not introduced by it, not fixed because they weren't named in scope):
- The same read-check-then-plain-`update()` TOCTOU shape this phase fixed for Task/Note/Handoff is also present in `medicationLifecycle.ts`'s shared `transition()` helper (`verifyMedicationOrder`/`rejectMedicationOrder`/`holdMedicationOrder`/`dispenseMedication`/`cancelMedicationOrder`) and in `appointment.ts`'s `cancelAppointment`/`markNoShow`/`checkInAppointment` — flagged by Phase 6.6's own doc already, still open.
- No dedicated handoff urgency/escalation notification mechanism — an `EMERGENCY`-urgency or `escalationRequired` handoff is visually flagged in the inbox but does not page/notify anyone.
- `CarePlanIntervention.responsibleRole` remains free text, not a closed set.

## 13. Production implications

This phase makes Nursing Core a real, reachable, concurrency-safe clinical workflow rather than a set of unconsumed backend endpoints plus one hardcoded button. It does not change the production database architecture — `schema.prisma`'s active provider remains `sqlite` for local dev, by the same established one-time-swap validation procedure Phase 6.6 used; the Postgres migration tree is validated, not live. General production-readiness items (TLS/security headers/rate limiting, backups/DR, connection pooling, environment-separated config) remain unaddressed and out of this phase's scope.
