# Aarogya Hospital OS — Threat Model

Scope: `/hospital-os` and `/api/hospital/*`, built in this pass. Same
conventions as `docs/STUDENT_PLATFORM_THREAT_MODEL.md`: concern, what stops
it today, residual risk. Several of these were exercised live against the
running dev server during this build (curl-driven, not just reasoned about)
— noted where that's the case.

## T-01 — Tenant (cross-facility) data leakage

**Concern**: staff at one facility read or modify another facility's
patients, encounters, beds, or bills.

**Mitigation**: `requireFacilityStaff()` (`src/lib/auth/hospitalRbac.ts`)
loads the caller's `HospitalStaffProfile` from the database and derives
`facilityId` from it — never from anything the client sends. Every hospital
route scopes its Prisma query with that `facilityId` (directly, or via a
join to `encounter.facilityId`). `AAROGYA_ADMIN` is the sole exception,
explicitly cross-facility, and must pass a `facilityId` the function does
not otherwise infer.

**Verified this pass**: only one facility is seeded, so true cross-facility
leakage isn't directly exercisable yet — the code path is reviewed, not
load-tested against a second tenant. **Recommended before a second facility
goes live**: add a second seeded facility and a test asserting a doctor at
Facility A gets 404/403 on Facility B's patient IDs.

## T-02 — Role escalation via client state

**Concern**: hospital staff claims a different role or facility to gain
broader access.

**Mitigation**: identical to Scholar's T-02 — `requireSession()` re-derives
`role` from the database on every request, never trusts the session
cookie's embedded role value alone, and RBAC checks happen server-side in
every route handler, never only in navigation.

**Verified this pass**: confirmed live — a `NURSE` session gets 403 on
`POST /api/hospital/orders/medication` (clinical ordering is DOCTOR-only);
a `STUDENT` session gets 403 on `/api/hospital/command-center` and
`/api/hospital/patients/[id]/chart`, and a 307 redirect to
`/hospital-os/login` when hitting `/hospital-os` directly; a `LAB_TECHNICIAN`
session gets 403 on `/api/hospital/billing/[encounterId]`.

## T-03 — IDOR on patients, encounters, admissions, orders

**Concern**: staff pass another patient's/encounter's/order's ID to read or
modify data outside their legitimate context.

**Mitigation**: every `[id]` route loads the row first, then checks its
`facilityId` (directly or via its parent `encounter`) against the caller's
`facilityId` before proceeding, throwing `NotFoundError` on mismatch —
consistent with Scholar's T-06 pattern (404, not 403, so a caller can't
distinguish "doesn't exist" from "exists but isn't yours").

**Residual risk**: IDs are Prisma `cuid()`s (high entropy, not sequential),
so blind enumeration isn't practical — but the facility check is what
actually enforces the boundary, not obscurity. Every route in this pass
that takes an `[id]` was written with this check; a future route added
without copying the pattern would reintroduce the gap; there is no
schema-level enforcement (e.g. no field-level Postgres row security). This
is the single most consequential pattern to preserve as the codebase grows.

## T-04 — Allergy-check override abuse

**Concern**: a clinician bypasses a documented severe-allergy conflict
without real justification, or the override is silent/unlogged.

**Mitigation**: `checkMedicationSafety()` blocks (returns `{blocked: true,
flags}` without creating the order) when a `danger`-severity flag exists
and no `overrideReason` was supplied. Supplying one creates the order with
`safetyFlags` and `overrideReason` both persisted on the row — visible on
the patient chart and in the audit log
(`hospital.medication.ordered` with `overridden: true`) forever after.

**Verified this pass**: live-tested — ordering amoxicillin for a patient
with a documented severe penicillin allergy returned `blocked: true`
without an override reason; supplying one created the order with both the
flag and the reason stored on it.

**Residual risk**: nothing currently reviews override patterns in
aggregate (e.g. "this clinician overrides allergy warnings unusually
often") — that's an analytics/quality-module concern not built this pass
(see architecture doc §11).

## T-05 — Discharge bypass (bed released without real readiness)

**Concern**: a bed is freed for the next patient before the current one is
actually ready to leave (clinically, financially, or logistically).

**Mitigation**: `finalizeDischarge()` (`src/lib/hospital/admission.ts`)
requires all six readiness flags true in the database — computed
server-side from the `Discharge` row, never trusted from the request body
directly (`PATCH` only ever sets individual flags, one at a time, each a
separate authorized action) — and throws `DischargeNotReadyError` listing
exactly which flags are missing if any aren't. The bed only transitions to
`CLEANING` inside that same all-or-nothing transaction.

**Verified this pass**: live-tested — finalize was attempted and blocked
appropriately by the underlying check logic before all six flags were set
in earlier manual testing during development; after setting all six, it
succeeded and the bed correctly became `CLEANING`.

## T-06 — Critical result suppression

**Concern**: a critical lab/imaging result goes unacknowledged
indefinitely, effectively "lost."

**Mitigation**: `computeAlerts()` (`src/lib/hospital/alertEngine.ts`) scans
for `LabResult`/`ImagingReport` rows with `isCritical: true` and
`acknowledgedAt`/`verifiedAt` null, surfacing them on the Command Center
with severity escalating from `watch` to `critical` the longer they sit
unacknowledged. There is no code path that auto-acknowledges a critical
result — only an explicit `DOCTOR` action
(`lab:result:acknowledge`/`imaging:report:verify`) clears it.

**Verified this pass**: live-tested end-to-end — a critical troponin result
and a critical CT finding were both released, appeared immediately in the
Command Center's alert feed with a real elapsed-time message, and
disappeared from unacknowledged counts only after the doctor endpoint was
called.

**Residual risk**: no push notification/paging integration this pass — a
clinician has to be looking at the Command Center or the patient chart to
see the alert. A real deployment needs the notification engine described
in the original brief (§91) wired to this exact condition before it can be
relied on operationally.

## T-07 — Bed-state race / illegal transitions

**Concern**: two concurrent requests both try to admit a patient into the
same bed, or a bed is moved through an operationally nonsensical state
sequence (e.g. `AVAILABLE` straight to `TRANSFER_PENDING`).

**Mitigation**: `admitPatient()`/`transferPatient()`/`finalizeDischarge()`
each re-read the bed's current status *inside* the same
`prisma.$transaction()` that writes the new status, so a concurrent second
admission attempt against an already-`OCCUPIED` bed fails the
`status !== AVAILABLE` check rather than racing past it (SQLite's
transaction isolation serializes these; the same pattern holds under
Postgres). `isTransitionAllowed()` enforces the state-machine edges listed
in `src/lib/hospital/bed.ts` — unit-tested (`bed.test.ts`).

## T-08 — Verification-document / uploaded-file handling

Not applicable to this pass — Hospital OS has no document upload surface
yet (no consent forms, no ID scans). Carried over from Scholar's T-09/T-04
as a reminder for when one is added: route it through the same restricted
`VerificationProvider`-style storage boundary, never inline in a table a
general query can return.

## T-09 — AI boundary

Not applicable — no AI copilot was built for Hospital OS this pass (see
architecture doc §11). When one is added (clinical summary, documentation
assistant, etc.), it must follow the same boundary Scholar's T-07/T-08
established: minimum necessary data in the prompt, no ground-truth
clinical facts the model could "leak" if none were given to it, and never
a code path from AI output to a database write without a human action in
between (mirroring T-04's allergy-override pattern: AI can *flag*, a human
*decides*).
