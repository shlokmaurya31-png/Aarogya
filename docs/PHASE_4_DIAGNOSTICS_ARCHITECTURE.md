# Phase 4 Architecture — Diagnostics OS (Laboratory + Radiology)

Extends Phase 3's Order envelope into two real diagnostic subsystems —
Laboratory (Milestone B) and Radiology (Milestone C) — built in three
staged, checkpointed milestones (A: Order integration, B: Lab, C:
Radiology). Nothing in Phase 0-3's clinical core, RBAC, audit system, or
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

## 10. Known gaps / deferred (carried forward honestly, not hidden)

- `LOST`/`CANCELLED` specimen states and `NO_SHOW`/`CANCELLED` study states are declared on their enums (matching the full real-world vocabulary) but have no route reaching them yet.
- Multi-specimen-per-order and multi-study-per-order are schema-ready (non-unique FKs) but not built.
- No panel-ordering UI (the catalog/panel data model supports it; only direct-API panel orders were exercised).
- Radiology QA, dosimetry tracking, pathology, blood bank, formal escalation chains, and notification delivery are explicitly out of scope per the brief.
- Cross-facility seed data for the second (Noida) facility is minimal for radiology; isolation was verified live via API rather than via a second full seeded scenario set.
