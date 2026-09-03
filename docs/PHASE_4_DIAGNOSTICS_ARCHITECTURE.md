# Phase 4 Architecture — Diagnostics OS (Laboratory + Radiology)

Extends Phase 3's Order envelope into two real diagnostic subsystems —
Laboratory (Milestone B) and Radiology (Milestone C) — then unifies them
into one coherent Diagnostics OS (Milestone D), built in four staged,
checkpointed milestones (A: Order integration, B: Lab, C: Radiology, D:
Unification). Nothing in Phase 0-3's clinical core, RBAC, audit system, or
tenant scoping was rewritten; every new capability is layered on top,
matching the pattern established in every prior phase.

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

- Unified worklist `q` search filtering happens in-memory, not in the Prisma `where` clause (§10.3) — fine at demo/seed scale, should move server-side before production data volumes.
- SLA/TAT metric keys exist and are threshold-aware, but no automated escalation or notification delivery consumes them yet (§10.8) — explicitly out of scope per the brief.
- Acknowledge endpoints remain plain updates rather than guarded compare-and-swap (§10.10) — documented as safe-by-idempotency, not upgraded, since Milestone D did not touch these routes.
- No PACS/DICOM/HL7/FHIR/ABDM/AI integration — unchanged from Milestone C's §9 interoperability boundary.
