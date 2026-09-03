# Phase 4 Architecture — Diagnostics OS (Laboratory + Radiology)

Extends Phase 3's Order envelope into two real diagnostic subsystems —
Laboratory (Milestone B) and Radiology (Milestone C) — then unifies them
into one coherent Diagnostics OS (Milestone D), then hardens the whole
surface for production (Milestone E), built in five staged, checkpointed
milestones (A: Order integration, B: Lab, C: Radiology, D: Unification, E:
Hardening). Nothing in Phase 0-3's clinical core, RBAC, audit system, or
tenant scoping was rewritten; every new capability is layered on top,
matching the pattern established in every prior phase.

See also `docs/PHASE_4_PRODUCTION_READINESS.md` for the Milestone E
checklist-format companion to this document's §12 hardening section.

## 1. Order integration (Milestone A)

`LabOrder`/`ImagingOrder` gained a nullable+unique `orderId` FK back to
`Order`, mirroring `MedicationOrder.orderId` exactly — the opposite
direction from the unused `Order.labOrderId`/`imagingOrderId` columns
Phase 3 had declared but never wired. Both are created inside the same
`$transaction` as the type-specific order via
`src/lib/hospital/orderEnvelope.ts`'s `createOrderEnvelope()`.
`LabOrderStatus`/`ImagingOrderStatus` graduated from free-text strings to
real Prisma enums at the same time (safe — every existing row's value was
verified to be a member of the new enum before migrating).

## 2. Laboratory architecture (Milestone B)

### Order → Accession → Specimen → Result

```
LabOrder (coarse: ORDERED → COLLECTED → IN_PROGRESS → RESULTED)
  └─ Specimen (fine-grained: COLLECTION_PENDING → COLLECTED → RECEIVED →
               ACCEPTED → RESULTED, or REJECTED [terminal, history preserved])
       └─ LabResult (versioned: ENTERED → VERIFIED → [AMENDED spawns a new
                      version, old row → SUPERSEDED/isCurrent:false])
```

One specimen per order (schema supports more via a non-unique FK;
workflow is scoped to one). `src/lib/hospital/specimenLifecycle.ts` holds
the state machine + guarded-`updateMany` concurrency idiom;
`src/lib/hospital/labResultLifecycle.ts` holds `enterResult`/
`verifyResult`/`amendResult`. `LabOrder.status` is driven by these
functions, never set directly by a route.

### Catalog, panels, reference ranges

`LabTestCatalog`/`LabPanel`/`LabPanelTest`/`LabReferenceRange` are
optional, additive — `LabOrder.catalogTestId`/`panelId` are nullable, so
every free-text order (`testName`/`category`) keeps working unchanged.
Abnormal flags (`computeAbnormalFlag` in `labCatalog.ts`) are computed
**only** when a catalog test + numeric value + a configured
`LabReferenceRange` all exist — never guessed. Every seeded range carries
`isDemoData: true` and a `sourceNote` disclaiming clinical validity (per
the explicit instruction never to present invented reference values as
authoritative).

### Critical results

No new alert table. `LabResult.isCritical`/`acknowledgedAt` are read live
by the existing `src/lib/hospital/alertEngine.ts` and
`commandCenter.ts` — acknowledging is `acknowledgedByStaffId`/
`acknowledgedAt` on the result row itself, same pattern as
`ClinicalHandoff`. Both queries filter `isCurrent: true` so an amended
(superseded) critical result can't alert forever after a corrected
version supersedes it.

## 3. Radiology architecture (Milestone C)

### Order → Study → Report

```
ImagingOrder (coarse: ORDERED → SCHEDULED → ACQUIRED → REPORTED)
  └─ ImagingStudy (fine-grained: SCHEDULED → ARRIVED → IN_PROGRESS →
                    COMPLETED, or CANCELLED/NO_SHOW)
       └─ ImagingReport (versioned: ENTERED → VERIFIED → [AMENDED spawns a
                          new version, old row → SUPERSEDED/isCurrent:false])
```

Mirrors Lab's coarse/detail split conceptually — not a shared table.
`src/lib/hospital/imagingStudyLifecycle.ts` holds the study state machine,
scheduling (with conflict prevention), check-in, claim/start (the
concurrency-tested "two techs claim the same study" case), and complete.
`src/lib/hospital/imagingReportLifecycle.ts` holds `enterReport`/
`verifyReport`/`acknowledgeReport`/`amendReport`. One study per order this
milestone (schema supports more via a non-unique FK).

**Verify vs. acknowledge — a real fix, not just a rename.** The original
schema conflated "radiologist signed the report" and "critical finding
cleared" into one `verifiedAt` field, which also left the
`imaging:report:verify` permission dead (no route ever enforced it).
`ImagingReport` now has both `verifiedByStaffId`/`verifiedAt`
(finalization, mirrors Lab's `LabResult.status`) **and** a separate
`acknowledgedByStaffId`/`acknowledgedAt` (critical-finding clearance,
mirrors `LabResult.acknowledgedAt` exactly). `alertEngine.ts`'s and
`commandCenter.ts`'s critical-imaging queries moved from `verifiedAt: null`
to `acknowledgedAt: null` accordingly — a report can be verified with a
critical finding still outstanding for acknowledgement, which is the
clinically correct decoupling.

`ImagingReport.studyId` is **nullable** — the pre-Milestone-C rows
predate `ImagingStudy` entirely (verified against live data before
migration: exactly 5 existing rows, all with a distinct `imagingOrderId`,
now `studyId: null`). Every report created through the new route always
sets it.

### Catalog, resources, scheduling

`ImagingCatalog` (code/name/modality/bodyRegion/prep/contrast/demo price)
mirrors `LabTestCatalog`. `ImagingResource` is a deliberately minimal
bookable modality/room — not a DICOM AE-title/device registry.
`ImagingOrder.catalogStudyId` is nullable, same backward-compatibility
rule as Lab's `catalogTestId`.

**Scheduling conflict prevention** (`scheduleStudy`/`rescheduleStudy` in
`imagingStudyLifecycle.ts`) mirrors `src/lib/hospital/appointment.ts`'s
exact idiom: inside a `$transaction`, count existing non-cancelled
`ImagingStudy` rows at the same `resourceId` + exact `scheduledAt`
timestamp; throw `ScheduleConflictError` if any exist. This is an
app-level check reliant on the database's transaction serialization —
**not** a DB-level guarantee, same documented limitation `appointment.ts`
already carries. It is a same-instant equality check, not a
start/end-range overlap check (matching `appointment.ts`'s own
simplification). Verified live under a genuine parallel race.

## 4. Concurrency — what's protected, how, and its real limits

Every guarded transition (`collectSpecimen`, `acceptSpecimen`,
`rejectSpecimen`, `verifyResult`, `amendResult`, `scheduleStudy`,
`startStudy`, `completeStudy`, `verifyReport`, `acknowledgeReport`,
`amendReport`) uses the same idiom:

```ts
const result = await tx.model.updateMany({ where: { id, status: EXPECTED }, data: { status: NEXT, ... } });
if (result.count !== 1) throw new SomeConcurrencyError(...);
```

This is new to the codebase as of Milestone B — every prior
transition (bed, queue, admission, transfer, even medication
administration) used `findUniqueOrThrow → JS status check → update-by-id`,
which is atomic **only** because SQLite serializes `$transaction` bodies
against a single writer. **On Postgres this codebase's default
`ReadCommitted` isolation would NOT make the older, unguarded pattern
safe** — two concurrent transactions could both read the same starting
status and both "win." The guarded-`updateMany` idiom introduced here
degrades gracefully to a real DB-level compare-and-swap on any
database, because the `WHERE status = EXPECTED` clause is evaluated by
the database at write time regardless of isolation level — this is the
one pattern in the whole codebase that is already Postgres-safe as
written, not just SQLite-safe. The scheduling conflict check
(`scheduleStudy`) is the one exception: it's a count-then-create, not a
compare-and-swap, and should be strengthened on Postgres with either
`SELECT ... FOR UPDATE` on the resource row or a partial unique index
`(resourceId, scheduledAt) WHERE status NOT IN ('CANCELLED','NO_SHOW')`.

No DB-backed test infrastructure exists (all unit tests are pure
functions, zero Prisma calls) — concurrency was verified via genuinely
parallel `curl` requests against the live dev server, not automated.

## 5. Billing

`src/lib/hospital/billing.ts`'s `createCharge`/`createChargeIfNotExists`
(extracted from the pre-existing manual billing route in Milestone B) are
shared, unmodified, by both Lab and Radiology order-creation routes. This
is the **first automatic charge-on-order-placement hook in the
codebase** — nothing, not even Phase 3 medication dispensing, auto-charges.
Idempotency is a `Charge.findFirst({sourceType, sourceId})` check before
create (no DB-level unique constraint enforces this — none exists on
`Charge`). The manual billing UI/route is untouched and does not use the
idempotent variant, since a human re-entering a charge on purpose is
valid there.

## 6. Integrations

- **Task engine**: `SPECIMEN_COLLECTION` / `IMAGING_PREP` tasks created via `Order.orderId`, no new task table.
- **Patient Chart**: Lab/Imaging cards show specimen/study status, abnormal-flag or critical badge, and an "amended vN" badge when `version > 1`.
- **Patient Timeline**: new event families per Milestone (specimen collected/accepted/rejected/recollected, result entered/verified/amended; study scheduled/arrived/started/completed, report entered/verified/acknowledged/amended) — the same `Promise.all` + per-type loop pattern the file already used, no schema change.
- **Command Center**: `lab: {...}` and `radiology: {...}` blocks inside `getClinicalOpsSnapshot`, same live-`Promise.all`-of-counts style as every existing metric.
- **Doctor Workspace**: lab and imaging critical counts are separate tiles (not summed), so a critical imaging finding can't hide behind a critical lab count.

## 7. RBAC

No `RADIOLOGIST` role exists; the codebase already established
DOCTOR-as-verifier for imaging in Phase 0 (distinct from Lab's
LAB_TECHNICIAN self-verification) — preserved, not changed. New
permissions follow the existing `domain:noun:verb` convention:
`lab:specimen:{collect,receive,accept,reject}`, `lab:result:{verify,amend}`,
`lab:catalog:manage`; `radiology:schedule`, `radiology:study:execute`,
`imaging:report:{acknowledge,amend}`, `radiology:{catalog,resource}:manage`.
All server-enforced via `requireFacilityStaff` — never a UI-only gate.

## 8. Audit

All new events follow the existing `hospital.<domain>.<event>` convention
and are recorded through the same synchronous `recordAuditEvent()` — no
new event bus, no separate audit table.

## 9. Future interoperability boundary (not implemented)

`ImagingStudy.accessionNumber` and `Specimen.accessionNumber` are
internal identifiers only. Neither model has a DICOM StudyInstanceUID,
PACS reference, or HL7/FHIR resource ID field yet — these are clean
future additions (new nullable columns), not a redesign, because the
internal workflow never depends on an external identifier existing.
**Not implemented, and not simulated**: PACS, DICOM networking, an HL7
interface engine, a FHIR server, ABDM integration, external
analyzer/modality integration, AI interpretation of any kind. The
intended future shape is an adapter boundary — `Internal Diagnostic
Model → Integration Adapter → external protocol` — with internal
clinical workflows never talking to an external protocol directly.

## 10. Diagnostics OS Unification (Milestone D)

### 10.1 Core architectural decision: no schema changes

A fresh audit before implementation confirmed the central fact that shaped
this milestone: **composing the existing `Order`/`LabOrder`/`Specimen`/
`LabResult`/`ImagingOrder`/`ImagingStudy`/`ImagingReport` models at the
service/API/UI layer is sufficient.** No `DiagnosticOrder` table, no new
alert table, no new task/billing engine, zero migrations. Lab and
Radiology's own state machines, routes, and permissions are byte-for-byte
unchanged from Milestone B/C — Milestone D is a composition layer on top,
not a rewrite.

### 10.2 Shared presentation status (IMPLEMENTED)

`src/lib/hospital/diagnosticsSnapshot.ts`'s `mapToDiagnosticStatus()` is a
pure, read-only function mapping each domain's real enums into one shared
vocabulary (`ORDERED | SCHEDULED | IN_PROGRESS | AWAITING_RESULT |
AWAITING_VERIFICATION | COMPLETED | CRITICAL | CANCELLED`) for display
only. It is never written back and never replaces `LabOrderStatus`/
`ImagingOrderStatus`/etc. An unacknowledged critical result/finding always
maps to `CRITICAL` regardless of underlying order/sub-status, matching how
`alertEngine.ts` already treats criticality and progress as independent
axes.

### 10.3 Unified worklist API (IMPLEMENTED)

`GET /api/hospital/orders/diagnostics/worklist` (`patient:read`-gated,
facility-scoped via `requireFacilityStaff`) composes the **same 14
underlying bucket queries** the two dedicated per-domain worklists
(`orders/lab/worklist`, `orders/imaging/worklist`) already run — not
reinvented logic. Every row is tagged `diagnosticType: "LAB"|"RADIOLOGY"`
and given a shared status via `mapToDiagnosticStatus`. Supports
`type=ALL|LAB|RADIOLOGY`, `priority=`, `status=`, and `q=` (patient
name/UHID/test-or-study-title) filtering. `counts` reflects the full
unfiltered bucket composition regardless of active filters (by design, so
the UI can show "20 total, 12 Lab, 8 Radiology, 7 critical" as context
even while a filter narrows `items`). `criticalItems` returns structured
fields — patient, encounter, source order id, severity, created time,
acknowledged-by/at — the exact same `isCritical && acknowledgedAt: null &&
isCurrent: true` condition `alertEngine.ts` already uses, reshaped for
this consumer (not a second alert system). Read-time TAT figures (avg
order→collection, avg order→study-start) are computed from the same
fetched buckets, never persisted or fabricated.

**Performance note (FUTURE EXTENSION):** `q` filtering happens in-memory
after a bounded (`take: 100` per bucket) fetch, mirroring the two
per-domain worklists' existing indexed-but-unfiltered-by-name queries. At
Postgres/production scale with materially larger row counts, `q` should
move into the Prisma `where` clauses (`patient.fullName`/`uhid` /
`accessionNumber` `contains`) instead of filtering post-fetch.

### 10.4 De-duplication (IMPLEMENTED)

`getDiagnosticsOperationalCounts(facilityId)` (same file) replaces the
near-identical pending/critical Lab+Imaging count queries that were
independently copy-pasted between `commandCenter.ts`'s
`getClinicalOpsSnapshot` and `doctor/dashboard/route.ts`. Both now call
the one shared helper once per request (verified live: Command Center and
Doctor Dashboard return byte-identical `pendingResults`/`criticalResults`
numbers for the same facility). A real parity gap found during the audit
— `clinicalOps.radiology.criticalFindingsAwaitingAcknowledgement` had no
Lab equivalent — was fixed by adding
`clinicalOps.lab.criticalLabsAwaitingAcknowledgement`.

`LabQueue.tsx`/`RadiologyQueue.tsx`'s byte-identical `SectionCard`/`Row`/
`ActionButton` components were extracted into
`src/components/hospital-os/diagnostics/shared.tsx`, alongside new
`DiagnosticPriorityBadge`/`DiagnosticStatusBadge`/`AmendmentBadge`/
`VerificationBadge`/`CriticalResultBanner`. Both dedicated queues import
from there now; their own state machines, routes, and action buttons are
untouched.

### 10.5 New unified workspace (IMPLEMENTED)

`/hospital-os/diagnostics` (`DiagnosticsQueue.tsx`) is the cross-diagnostic
entry point: ALL/LAB/RADIOLOGY tabs, priority/status filters, a search
box, a critical-items banner with inline **Acknowledge** (calling the
*existing* lab/imaging acknowledge endpoints directly — zero new mutation
logic), and read-only worklist rows linking out to `/hospital-os/lab` or
`/hospital-os/radiology` for detailed operational actions
(collect/schedule/verify/amend stay in the dedicated per-domain
workspaces, which are unchanged and still directly reachable). Reads
initial `type`/`priority`/`status` filter state from the URL, so Doctor
Workspace tiles can deep-link into a pre-filtered view (e.g.
`?type=LAB&status=CRITICAL`).

### 10.6 Command Center, Doctor Workspace, Patient Chart (IMPLEMENTED)

- **Command Center**: new top-level `diagnostics: { volume, pending,
  safety, risk }` block, built from the one shared helper (verified live:
  no duplicate DB round-trip — one fetch feeds both the new top-level
  field and `clinicalOps`).
- **Doctor Workspace**: the 4 diagnostic tiles (pending/critical ×
  lab/imaging) now link into `/hospital-os/diagnostics`, filtered —
  direct navigation into the relevant view instead of an inert number.
- **Patient Chart**: existing Lab/Imaging cards are wrapped in a shared
  "Diagnostics" section heading (visual grouping only — the two domains'
  distinct content is not flattened together) and use the new shared
  `AmendmentBadge` for consistent "amended vN" presentation. Verified live
  against a real 2-version amendment chain (see §10.9).

### 10.7 Navigation (IMPLEMENTED, with a documented judgment call)

`HospitalShell.tsx`'s nav item type gained an additive, optional
`children?: NavItem[]`. `HOSPITAL_ADMIN`/`DOCTOR`/`NURSE` get a nested
"Diagnostics → Overview / Laboratory / Radiology" group (none of these
roles had direct Lab/Radiology nav access before Milestone D — they
reached diagnostics only via Patient Chart). `LAB_TECHNICIAN`/
`RADIOLOGY_TECH` deliberately keep their existing single flat "Lab
Queue"/"Imaging Queue" link **and** additionally get a second flat
"Diagnostics" item, rather than nesting their one existing link inside a
group they'd have to expand — a judgment call (documented in code
comments) that a single-purpose operational role is better served by
keeping its one-click link than by literally matching the nav diagram.
Verified live: both patterns render correctly for their respective roles.

### 10.8 SLA/TAT foundation (IMPLEMENTED, FUTURE EXTENSION noted)

`src/lib/hospital/sla.ts`'s `DEFAULT_SLA_MINUTES` gained diagnostic metric
keys (`LAB_SPECIMEN_COLLECTION`, `LAB_SPECIMEN_RECEIPT`, `LAB_RESULT_TAT`,
`IMAGING_STUDY_COMPLETION`, `IMAGING_REPORT_TAT`), reusing the real, live
`SlaPolicy`/`getSlaThresholds()` infrastructure Phase 2 already built —
zero schema change, since `SlaPolicy.metric` is a plain string. **Not
implemented (FUTURE EXTENSION, explicitly out of scope per the brief):**
automated escalation or notification delivery when a threshold is
breached — these keys only make TAT figures threshold-aware for future
display/alerting work, they don't wire any escalation path today.

### 10.9 Billing / Task / Audit / RBAC — verified, not rebuilt (IMPLEMENTED)

Per the brief's instruction to verify rather than duplicate:

- **Billing**: confirmed exactly-once via live testing — a full Lab
  lifecycle (order → collect → receive → accept → result → verify →
  acknowledge → amend → acknowledge) and a full Radiology lifecycle
  (order → schedule → check-in → start → complete → report → verify →
  acknowledge → amend → acknowledge) each produced **exactly one** `Charge`
  row, despite the amendment step. `createChargeIfNotExists` (Milestone B)
  is unmodified and was not touched.
- **Task engine**: confirmed `SPECIMEN_COLLECTION`/`IMAGING_PREP` tasks are
  created exactly once per order, via the unmodified generic `Task` table.
- **Audit**: confirmed a complete, correctly-ordered `hospital.lab.*` (9
  events) and `hospital.imaging.*` (10 events) trail for the full
  lifecycles above, including `resultAmended`/`reportAmended` and
  `criticalResultAcknowledged`/`criticalFindingAcknowledged` — no gaps, no
  duplicate event types beyond the two acknowledge calls a real amendment
  cycle legitimately triggers.
- **RBAC**: confirmed live — a nurse attempting `lab:result:enter` gets
  403; a cross-facility (Noida) account attempting to acknowledge an AMC
  critical result gets 404 (not found, not a permission-existence leak);
  an unauthenticated request gets 401. No new permissions were added; the
  unified worklist reuses `patient:read` and the unified UI's only
  mutation (acknowledge) calls the existing lab/imaging acknowledge routes
  directly under their existing permissions.
- **Facility isolation**: confirmed live, including under genuine
  concurrent load — simultaneous AMC-admin and Noida-admin requests to the
  same unified worklist endpoint returned disjoint item sets with zero id
  overlap.

### 10.10 Concurrency (IMPLEMENTED / documented characteristic)

Milestone D added no new guarded state transitions (all guarded-`updateMany`
transitions remain exactly as Milestone B/C left them). Two concurrency
behaviors were verified live against the unified surface:

- Two truly simultaneous `acknowledge` requests (fired in parallel via
  Bash background jobs) both returned `200` with the same final
  `acknowledgedByStaffId`. This is **safe by design, not a bug**: the
  acknowledge route (`orders/lab/[id]/acknowledge`,
  `orders/imaging/[id]/report/[reportId]/acknowledge`) is a plain
  unconditional update rather than a guarded compare-and-swap, but
  acknowledgement is naturally idempotent — setting the same
  `acknowledgedByStaffId`/`acknowledgedAt` fields twice causes no data
  corruption, no double billing, no double task creation. This is
  unchanged Milestone B/C behavior, reused as-is (not introduced by D).
- Concurrent cross-facility reads (§10.9) showed no leakage.

### 10.11 Architectural test: is `/hospital-os/diagnostics` a real Diagnostics OS?

Verified live, not assumed: a critical Lab result and a critical Radiology
finding for different patients both appear in the same `criticalItems`
list with a consistent structured shape; the ALL/LAB/RADIOLOGY, priority,
status, and free-text filters all narrow the same underlying item set
correctly; Command Center and Doctor Workspace report identical
lab/imaging numbers because they share one aggregation function; and the
nav, Patient Chart, and Doctor Workspace all route into the same unified
surface. `/hospital-os/diagnostics` functions as one coherent
cross-diagnostic view — not merely a dashboard bolted onto two unrelated
systems — while `/hospital-os/lab` and `/hospital-os/radiology` remain
fully intact for domain-specific operational work.

## 11. Known gaps / deferred (carried forward honestly, not hidden)

Carried forward unchanged from Milestones B/C (not silently expanded by
Milestone D):

- `LOST`/`CANCELLED` specimen states and `NO_SHOW`/`CANCELLED` study states are declared on their enums (matching the full real-world vocabulary) but have no route reaching them yet.
- Multi-specimen-per-order and multi-study-per-order are schema-ready (non-unique FKs) but not built.
- No panel-ordering UI (the catalog/panel data model supports it; only direct-API panel orders were exercised).
- Radiology QA, dosimetry tracking, pathology, blood bank, formal escalation chains, and notification delivery are explicitly out of scope per the brief.
- Cross-facility seed data for the second (Noida) facility is minimal for radiology; isolation was verified live via API rather than via a second full seeded scenario set.

New from Milestone D, explicitly deferred (FUTURE EXTENSION, not built this milestone):

- Unified worklist `q` search filtering happens in-memory, not in the Prisma `where` clause (§10.3) — fine at demo/seed scale, should move server-side before production data volumes. Re-confirmed still correct to defer during Milestone E's audit (§12.19) — it narrows an already-bounded (`take: 100`/bucket) fetch, not a correctness or security issue.
- SLA/TAT metric keys exist and are threshold-aware, but no automated escalation or notification delivery consumes them yet (§10.8) — explicitly out of scope per the brief.
- ~~Acknowledge endpoints remain plain updates rather than guarded compare-and-swap~~ — **fixed in Milestone E** (§12.3): the Lab acknowledge route now uses a guarded CAS scoped to the specific current critical result, matching the pattern Imaging's `acknowledgeReport` already used.
- No PACS/DICOM/HL7/FHIR/ABDM/AI integration — unchanged from Milestone C's §9 interoperability boundary.

## 12. Production Hardening & Readiness (Milestone E)

Hardening-only milestone: no new functionality, no architecture rewrites.
A fresh audit (7 parallel agents covering Lab lifecycle, Radiology
lifecycle, RBAC/IDOR, billing/task/audit, input validation/error
semantics, secrets/performance, and DB integrity) found and fixed real
defects; everything not fixed is documented honestly below, not hidden.
Each item is classified **VERIFIED** (already correct, confirmed by
re-audit), **HARDENED** (a real gap was found and fixed this milestone),
**KNOWN LIMITATION** (a real, understood gap not fixed — deliberately, with
a reason), or **FUTURE PRODUCTION REQUIREMENT** (needs infrastructure or a
larger change out of this milestone's scope).

### 12.1 State-machine guarantees — HARDENED + VERIFIED

Every guarded transition (Lab: collect/receive/accept/reject/verify/amend;
Radiology: schedule/checkin/start/complete/cancel/verify/amend) was
re-verified to use the `updateMany({where:{id,status:EXPECTED}})` + count
check idiom, correctly rejecting an out-of-state or concurrently-raced
transition with a clean 400 — **VERIFIED**, not just assumed.

Two real state-machine gaps were found and fixed (**HARDENED**): the
`specimen/reject` route let staff select a `COLLECTED` specimen, but the
transition map only allowed `RECEIVED→REJECTED`, so rejecting a
mislabeled/wrong-tube specimen caught before receipt always failed with a
confusing error; `SPECIMEN_ALLOWED` now permits `COLLECTED→REJECTED`. The
`study/cancel` route let staff select an `ARRIVED` study, but the map only
allowed cancelling from `SCHEDULED`, so there was no way to abort imaging
after a patient arrived (contrast allergy discovered, patient
decompensates) — `STUDY_ALLOWED` now permits `ARRIVED→CANCELLED`. Both
gaps met the brief's own bar for touching a state machine during a
hardening-only milestone: a demonstrated real correctness defect, not a
stylistic preference.

### 12.2 Clinical immutability — VERIFIED, with one HARDENED gap

`amendResult`/`amendReport` were re-verified to reject amending a
non-VERIFIED or non-current row (both via an app-level check and a CAS on
the supersede step) — a superseded/amended row cannot be silently
overwritten through the intended API, an unintended API, a malformed
request, or a repeated request. **VERIFIED.**

The one real gap (**HARDENED**, see §12.4): before this milestone, two
concurrent `enterResult`/`enterReport`/`scheduleStudy` calls could both
create a "current" row for the same order — not an overwrite of history,
but a duplication of the current-version slot the rest of the system
assumes is singular. Fixed with a DB-level constraint, not just an
app-level check.

### 12.3 Concurrency guarantees — HARDENED

Every race the brief asked for was fired live against the running dev
server (paired parallel `curl` requests, not simulated) and DB-verified
after:

| Race | Before | After |
|---|---|---|
| Duplicate order submission (double-click/retry) | Both requests created a full order+specimen+charge+task | Both return the **same** order; DB-verified exactly 1 order/specimen/charge/task |
| Concurrent LabResult entry on one order | Both could create a "current" row | One succeeds, one gets a clean 400; DB-verified exactly 1 current row |
| Concurrent ImagingReport entry on one order | Both could create a "current" row | Same as above |
| Concurrent ImagingStudy scheduling on one order | Both could create a study row | Same as above |
| Concurrent specimen recollection | Both could create a recollection row | One succeeds, one gets "already recollected"; DB-verified exactly 1 |
| Lab critical-result acknowledge (arbitrary `results[0]`, unguarded) | Could ack a non-critical result; two concurrent acks both silently "won" under different staff IDs | Scoped to the specific critical/unacknowledged current result via a guarded CAS (`acknowledgeResult`, mirroring Imaging's `acknowledgeReport`); non-critical/already-acknowledged now cleanly 404s |

The acknowledge endpoints (`hospital.lab.criticalResultAcknowledged`,
`hospital.imaging.criticalFindingAcknowledged`) are now both guarded CASes
with an `isCritical`/`acknowledgedAt: null` scope — **HARDENED** for Lab,
**VERIFIED** already-correct for Imaging.

### 12.4 PostgreSQL readiness — HARDENED + documented KNOWN LIMITATION

The duplicate-current-row race (§12.3) was closed with **real DB-level
partial unique indexes**, not just app-level checks — the fix works
identically under SQLite and Postgres, because a `WHERE`-clause unique
index is evaluated by the database at write time regardless of isolation
level (the same property that already made the guarded-`updateMany`
pattern Postgres-safe since Milestone B):

- `LabResult`: unique on `(labOrderId, COALESCE(catalogTestId,''))` WHERE `isCurrent = true`
- `ImagingReport`: unique on `imagingOrderId` WHERE `isCurrent = true`
- `ImagingStudy`: unique on `imagingOrderId` WHERE `status NOT IN ('CANCELLED','NO_SHOW')`
- `Specimen`: unique on `recollectionOfSpecimenId` (plain unique — NULL exemption is exactly the desired behavior for never-recollected specimens)
- `Charge`: unique on `(sourceType, sourceId)` (plain unique — NULL exemption is exactly right for manual charges, which never set these fields)

These live only in hand-authored migration SQL (`prisma/migrations/20260903020000_phase4_milestone_e_hardening_indexes/migration.sql`) because Prisma's schema DSL has no partial/filtered-index syntax. **The WHERE-clause syntax used is already Postgres-compatible unchanged** — verified by reading the Postgres `CREATE UNIQUE INDEX ... WHERE` grammar, which is identical to SQLite's for this case; no rewrite will be needed at cutover, only re-running/porting the migration file through whatever tooling generates the Postgres migration set.

**KNOWN LIMITATION, unchanged from Milestone C, re-confirmed not silently hidden**: the resource-scheduling *double-booking* check (`scheduleStudy`/`rescheduleStudy`'s `resourceId`+`scheduledAt` conflict count) remains an app-level count-then-create relying on transaction serialization — safe on SQLite, not safe under Postgres's default `READ COMMITTED` isolation. This is a different invariant from the duplicate-*study*-row race Milestone E fixed (§12.5 below has the detail) and was deliberately not given a DB constraint this milestone, because a `(resourceId, scheduledAt)` uniqueness constraint would forbid legitimate different-facility or different-resource bookings at the same instant and is a larger semantic change than a hardening pass should make without stronger evidence. **FUTURE PRODUCTION REQUIREMENT**: `SELECT ... FOR UPDATE` on the resource row inside the scheduling transaction, or a proper partial unique index on `(resourceId, scheduledAt) WHERE status NOT IN ('CANCELLED','NO_SHOW')`, before relying on this under concurrent Postgres load.

### 12.5 Scheduling concurrency — HARDENED (duplicate-study race) + documented KNOWN LIMITATION (double-booking race)

Two distinct races exist in imaging scheduling, and Milestone E fixed one of them:

1. **Duplicate active study per order** (two concurrent `scheduleStudy` calls for the *same order*) — **HARDENED** via the `ImagingStudy_active_per_order` partial unique index (§12.4); verified live, exactly 1 study survives.
2. **Resource double-booking** (two concurrent `scheduleStudy` calls for *different orders* at the same `resourceId`+`scheduledAt`) — **KNOWN LIMITATION**, unchanged, see §12.4's Postgres note. SQLite-safe today, needs the documented Postgres hardening before relying on it at production concurrency.

### 12.6 Idempotency — HARDENED (order creation) + VERIFIED (everything else)

Classified per the brief's ask ("if the client sends this request twice, what happens?"):

| Endpoint | Classification | Why |
|---|---|---|
| Lab/Imaging order creation | **HARDENED** | Was unsafe (see §12.7) — a 15-second same-encounter+testName/studyDescription+staff dedupe window now returns the existing order instead of creating a duplicate. Documented honestly as a **pragmatic mitigation for the realistic double-click/retry threat model, not a bulletproof distributed idempotency-key system** — a determined adversary racing precisely within the window could still get two orders through, since the dedupe check and the create aren't a single atomic DB operation. The smallest-correct-mechanism call per the brief: this is an internal hospital staff UI, not a public retry-prone API, so a time-window dedupe was judged sufficient over a full idempotency-key scheme. |
| Charge creation (`createChargeIfNotExists`) | **HARDENED** | Was app-level-only (findFirst-then-create); now backed by a DB-level unique constraint + a `P2002` catch that falls back to returning the winner's row, so a genuine race is both prevented and handled gracefully (caller gets a valid charge back, not a 500). |
| Specimen collect/receive/accept/reject | **VERIFIED naturally rejected** | Guarded CAS — a retry after the first attempt already changed status gets a clean 400, no side effect. |
| Result/report verification | **VERIFIED naturally rejected** | Same CAS pattern. |
| Result/report amendment | **VERIFIED naturally rejected** | Same CAS pattern (plus the app-level VERIFIED/isCurrent pre-check). |
| Specimen recollection | **HARDENED** | Was a racy read-then-write; now backed by a DB unique constraint (§12.4), naturally rejected on retry. |
| Critical-result/finding acknowledgement | **VERIFIED safely idempotent** | Setting the same `acknowledgedByStaffId`/`acknowledgedAt` twice is harmless by nature — no data corruption, no double billing/task. Deliberately left as a plain guarded update, not a stronger idempotency key, since the field being set is inherently idempotent. |
| Study scheduling | **HARDENED** | Same as specimen recollection — now backed by the `ImagingStudy_active_per_order` constraint. |

### 12.7 Billing safety — HARDENED (CRITICAL finding fixed)

The most severe finding of this milestone: `createChargeIfNotExists`'s
idempotency check compared against `sourceId: createdOrder.id`, an ID
generated fresh by the *same* request — so it could never actually catch a
duplicate order submission (the two requests never shared a `sourceId`, so
the check trivially passed both times). A double-click or client retry on
"place order" deterministically produced two full orders, two specimens/
tasks, and **two charges** for one clinical intent. Fixed via the §12.6
order-creation dedupe (root cause) plus a DB-level `Charge` uniqueness
constraint (defense in depth for any *other* call site that might reuse a
`sourceId`, present or future). **Verified live**: a genuine parallel race
against real order-creation now produces exactly 1 order, 1 specimen, 1
charge, 1 task, DB-checked directly (not just via the API response).

Every charge-creation call site in the diagnostics-adjacent codebase was
enumerated (`createCharge`/`createChargeIfNotExists`, called only from
`orders/lab/route.ts` and `orders/imaging/route.ts` for auto-charges, and
the manual billing route for user-initiated charges) — no other
duplication source found. **VERIFIED** correct encounter/facility/order/
amount attribution on every call site re-read during this audit.

### 12.8 Task safety — VERIFIED + audit gap HARDENED

Automatic task creation (`SPECIMEN_COLLECTION`/`IMAGING_PREP`) is
transactional with its order and was, per §12.7, only ever duplicated as a
side effect of the order-duplication bug — fixed by the same root-cause
fix. **VERIFIED** correct patient/encounter/facility/order/priority/type
attribution. The one real gap, a missing dedicated audit event for task
creation (§12.9), is now fixed.

### 12.9 RBAC — HARDENED (two real findings fixed)

1. **`patient:read` over-granted full clinical chart access** to
   FRONT_DESK/BILLING_STAFF (roles with no other clinical permission, but
   which could read complete notes, diagnoses, medication orders, and
   critical lab/imaging values through the same permission string used for
   "can look this patient up"). **HARDENED**: new narrower
   `clinical:chart:read` permission, granted only to DOCTOR/NURSE/
   LAB_TECHNICIAN/RADIOLOGY_TECH/PHARMACIST/HOSPITAL_ADMIN/AAROGYA_ADMIN,
   now gates `patients/[id]/chart`, both worklist routes, both order-list
   GETs, and the unified diagnostics worklist. `patient:read` itself is
   untouched everywhere else — verified live that FRONT_DESK/BILLING_STAFF
   now get a clean 403 on chart/worklist routes while every clinical role
   still gets 200, and FRONT_DESK/BILLING_STAFF's own legitimate routes
   (patient list/search for check-in/billing) are unaffected.
2. **Imaging `reschedule` trusted a client-supplied `resourceId` with no
   facility check** — a real cross-tenant IDOR (`schedule`'s sibling route
   already had this check; `reschedule` didn't). **HARDENED**: identical
   check added. Verified live with a temporary cross-facility resource:
   rejected with a clean 404 before the fix would have accepted it;
   confirmed the fix doesn't break a legitimate same-facility reschedule.

A full role × diagnostic-action permission matrix was rebuilt and
cross-checked against every route's actual `requireFacilityStaff` call
(not just the permission table) — no other missing/inconsistent checks
found. The apparent Lab (tech self-verifies) vs. Radiology (doctor
verifies) authority asymmetry, flagged by the audit, was traced back to
this document's own §7 — **already an intentional Phase-0 design decision**
("no RADIOLOGIST role exists; DOCTOR-as-verifier for imaging... preserved,
not changed"), not a defect. No fix needed.

### 12.10 Facility isolation — HARDENED (one landmine fixed) + VERIFIED

`alertEngine.ts`'s critical-lab, critical-imaging, and stalled-discharge
queries had no `facilityId` in their `where` clause, relying entirely on a
post-fetch `continue` to drop other tenants' rows — not currently
exploitable (the `continue` was present and correct), but a landmine: any
future refactor that dropped it, or added a `take` cap before the filter,
would leak another facility's PHI into the wrong facility's alert feed, and
it was also an unbounded full-table scan across every tenant on every
Command Center load. **HARDENED**: facility filter moved into `where`,
matching every other query in the file.

Every other diagnostics route re-audited (worklists, chart route,
Command Center, Doctor Dashboard, the unified diagnostics worklist) was
**VERIFIED** already correctly facility-scoped, including under genuine
concurrent load (simultaneous cross-facility requests during this
milestone's live testing returned disjoint item sets with zero overlap,
same as Milestone D's verification).

### 12.11 Audit coverage — HARDENED (two gaps fixed) + VERIFIED

Automatic `SPECIMEN_COLLECTION`/`IMAGING_PREP` task creation and the
diagnostic auto-charge hook previously had no dedicated audit event (only
discoverable indirectly via `hospital.lab.ordered`/`hospital.imaging.
ordered`'s detail, which didn't even include the task/charge IDs).
**HARDENED**: both order-creation routes now fire `hospital.task.created`
and `hospital.billing.chargeCreated` (reusing the existing event types the
manual routes already use — no new audit system). Every other clinically
meaningful mutation (order, collection, receipt, acceptance, rejection,
recollection, result/report entry, verification, amendment, critical
acknowledgement, study execution) was **VERIFIED** to already fire a
correctly-timed (strictly after `$transaction` commit, never before or
inside) audit event with the actor's real ID.

**KNOWN LIMITATION, not fixed this milestone**: `AuditEvent` has no
`facilityId`/`patientId` columns — a codebase-wide gap (every phase, not
Phase-4-specific), so this milestone's diagnostics-scoped hardening pass
did not touch the core shared `AuditEvent` model. Investigating "every
diagnostic audit event for patient X" or "...within facility Y" today
requires joining `detail`'s embedded IDs back through the domain tables,
not a direct query filter. **FUTURE PRODUCTION REQUIREMENT** for a
platform-wide (not Phase-4-scoped) hardening pass.

### 12.12 Error semantics — HARDENED (one coercion bug) + VERIFIED

`Boolean(isCritical)` on result/report entry meant a string-serialized
`isCritical: "false"` persisted as `true` (any non-empty string is
truthy in JS) — a silent clinical-alerting correctness bug (manufacturing
phantom critical alerts), not a crash. **HARDENED**: both routes (and the
amend routes, which previously had no type check on `isCritical` at all)
now reject a non-boolean `isCritical` with a clean 400.

`withApiErrors` (the load-bearing safety net for the whole diagnostics
surface) was **VERIFIED**: authentication failures → 401, authorization →
403, not-found/cross-facility → 404, validation → 400, and any *unexpected*
exception (a raw Prisma error, a bug) → a hardcoded, sanitized `{error:
"Internal error."}` 500 that never leaks `.message`/stack traces — checked
live against a nonexistent-ID request on a real route (clean JSON 404, not
a framework error page or a Prisma leak).

### 12.13 Input validation — HARDENED

Added server-side validation, previously missing, across order-creation and
result/report-entry/amendment routes: a `priority` whitelist
(`ROUTINE`/`URGENT`/`STAT`, matching the vocabulary these fields actually
use — not the generalized `Order.priority` enum's `EMERGENCY`), a
`resultType` whitelist against `LabResultType`, a `scheduledAt`
parse-and-bounds check (`isNaN` guard + a 1-year-out sanity cap) on both
schedule and reschedule, a `numericValue` finite+magnitude bound, and
~10,000-character length caps on `value`/`findings`/`impression`/`reason`/
`notes`/`testName`/`category`/`studyDescription`/`modality`. Every check
was verified live to return a clean 400 with a descriptive message, not an
uncaught Prisma validation error surfacing as a 500 — and every corresponding
happy-path request was re-verified to still succeed unchanged.

### 12.14 Performance — HARDENED (the one finding rated worth fixing now)

`src/lib/patient/timeline.ts`'s 16 `findMany` calls and `patients/[id]/
chart/route.ts`'s several nested includes (`notes`, `medicationOrders`
incl. `administrations`/`dispensingRecords`, `labOrders`, `imagingOrders`,
`diagnoses`, `carePlans` incl. `interventions`) had no `take`, unlike the
same files' own already-bounded `vitals`/`handoffs` precedent — at
synthetic seed scale invisible, at real hospital scale (a chronic patient
with years of q4h-charted vitals) a genuine multi-second/memory-heavy
request. **HARDENED**: `take` caps added matching the existing bounded
precedent in the same files (200/sub-query for the timeline, 20-50 for the
chart route, ordered by each query's own recency field so truncation drops
the *oldest* rows, not an arbitrary DB-order subset).

The two dedicated Lab/Radiology worklist routes' 14 bucket queries
(unbounded, unlike the unified diagnostics worklist's own `take: 100`
precedent) and `commandCenter.ts`'s two unbounded-but-naturally-bounded
queries (beds, active encounters — scale with facility size, not with
historical data) were **audited and judged not worth fixing this
milestone** — real but lower-severity than the timeline/chart finding, and
adding `take` to 14 near-identical queries is exactly the kind of low-value
churn a hardening pass should avoid absent evidence it's an active problem.
Composite indexes (§12.4's neighbors, listed in
`docs/PHASE_4_PRODUCTION_READINESS.md`) were added instead, which help
these same routes' query plans directly.

### 12.15 Seed behavior — documented, not changed

`prisma/seed.ts` documents itself as "safe to re-run: uses upsert-by-
unique-key throughout" — true for users/institutions/achievements/catalog
rows. **KNOWN LIMITATION**: the Phase 4 diagnostic demo scenarios
(`seedData/hospital.ts`'s lab/imaging order creation) use plain `.create()`,
so re-running seed *without* a prior `migrate reset` would duplicate the
demo diagnostic data. Not a production concern (seed data is never run
against a production database in this workflow — every reseed in this
project's history has gone through `migrate reset --force` first, with
explicit user consent each time per this session's established discipline)
and out of scope to rewrite demo-fixture generation into full upsert
semantics during a hardening pass focused on production code paths.

### 12.16 Secrets — VERIFIED clean

No real/leaked secrets in the tracked repository. `.env`/`.env.local` are
`.gitignore`'d and confirmed via `git ls-files`/`git log --all` to have
never been committed at any point in history. `.env.example` contains only
empty placeholders. Seed demo passwords (`Scholar@123`, `Hospital@123`) are
clearly synthetic-labeled, always hashed via `scrypt` before storage, and
never logged in plaintext except the seed script's own console summary
listing which demo account uses which well-known password — a
**FUTURE PRODUCTION REQUIREMENT**, not a current leak: gate demo-account
seeding behind an explicit non-production check before this seed script
could ever be pointed at a real deployment.

### 12.17 Security configuration — VERIFIED (application layer)

`requireFacilityStaff` re-derives `facilityId` from the DB-backed
`HospitalStaffProfile` row for every role except `AAROGYA_ADMIN`, never
trusting a client-supplied value — re-verified across every route touched
this milestone. Role is always re-derived from the DB, never trusted from
the session cookie payload. Passwords use `scrypt` + `timingSafeEqual`.
**FUTURE PRODUCTION REQUIREMENT** (infrastructure-level, not verifiable
locally): TLS termination, security headers (CSP/HSTS/etc.), production
session-cookie flags (`Secure`/`SameSite` behavior under a real HTTPS
origin), rate limiting, and a WAF/reverse-proxy layer — none of these are
application-code concerns this milestone could fix, and none were
fabricated as "done."

### 12.18 Clinical safety invariants — VERIFIED, adversarially

Every dangerous-state scenario the brief listed was tested against the
live application, not assumed: a result cannot be verified/amended out of
its correct prior state (§12.2); a critical result/finding cannot vanish
after amendment (the amended version inherits `isCritical` and re-enters
`criticalItems` unacknowledged — confirmed in Milestone D's E2E and
re-confirmed this milestone); critical acknowledgement is now correctly
attributed to the acknowledging staff member, not an arbitrary result
(§12.3); a mismatched `patientId`/`encounterId` pair is now rejected before
any record is created (§12.19); wrong-facility mutation attempts
consistently fail closed with a clean 404 (§12.10), never a silent
misattribution.

### 12.19 Wrong-patient / cross-record-linkage risk — HARDENED (CRITICAL finding fixed)

`patientId` in the lab/imaging order-creation body was previously never
cross-checked against `encounter.patientId` — a client could submit an
`encounterId` for one patient and a `patientId` for a *different* patient,
and the resulting `LabOrder`/`Specimen`/`ImagingOrder`/`ImagingStudy` rows
would carry that mismatched `patientId` verbatim. Because
`src/lib/patient/timeline.ts` and `summary.ts` query lab/imaging
rows **directly by `patientId`, not by encounter ownership**, this was a
genuine wrong-patient PHI disclosure reachable on a single ordinary
request (no race required) — ranked CRITICAL. **HARDENED**: both order
routes now reject a `patientId`/`encounter.patientId` mismatch with a
clean 400 before any row is created. Verified live.

### 12.20 Production blockers summary

See `docs/PHASE_4_PRODUCTION_READINESS.md` for the full checklist. In
short: the application-layer findings that would have blocked a real
hospital deployment are fixed. What remains is infrastructure (Postgres
migration + the two documented Postgres-specific concurrency items,
TLS/headers/rate-limiting, secret rotation tooling, backups/DR, real
observability) — none of it fabricated as done, all of it explicitly
itemized as **FUTURE PRODUCTION REQUIREMENT** rather than silently
omitted.
