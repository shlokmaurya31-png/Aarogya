# Phase 3 Architecture — Doctor OS, Nursing OS, Medication Lifecycle, Pharmacy

Extends Phase 0-2's clinical core and patient-flow foundation into a real
prescribe → verify → dispense → administer → reconcile medication
lifecycle, plus the Doctor/Nursing/Pharmacy workspaces built on top of it.
Nothing in Phase 0-2's bed/admission/encounter/ADT machinery, RBAC, audit
system, or tenant scoping was rewritten — every new capability is layered
on top, matching the pattern established in every prior phase.

## 1. The generalized Order decision (brief §1 — resolved)

**Decision: an additive polymorphic envelope, not a destructive rewrite.**

A new `Order` table carries the common lifecycle concepts brief §1 asks
for — facility/encounter/patient/ordering clinician, `orderType`, a
coarse `status`, priority, indication, notes, start/discontinue/cancel
timestamps. It does **not** replace `MedicationOrder`, `LabOrder`,
`ImagingOrder`, or `Referral` — each keeps its own detailed,
type-specific status vocabulary exactly as Phase 0/1 built it. Instead,
each of those four tables gained a **nullable** `orderId` foreign key
back to `Order`:

```
Order (facility/encounter/patient/orderingStaff/orderType/status/priority)
  ├─ MedicationOrder   (orderId nullable, @unique)
  ├─ LabOrder          (not yet linked this phase — see §9)
  ├─ ImagingOrder       (not yet linked this phase — see §9)
  └─ Referral           (orderId nullable, @unique)
```

Every **new** medication order and referral created from this phase
forward writes both rows atomically (`createOrderEnvelope()` inside the
same `$transaction` as the type-specific create). Every row created
*before* this phase has `orderId = null` — a safe, silent gap, not a
data-loss risk; nothing reads `Order` expecting full historical coverage.

**What this buys**: `Order.findMany({ where: { patientId, status: "ACTIVE" } })`
answers "every active order for this patient, any type" in one query —
the actual capability brief §1 was chasing — without migrating four
working tables' status columns onto one shared vocabulary that doesn't
fit all four (a STAT lab order's lifecycle and a PRN medication's
lifecycle are genuinely different shapes).

**What was deliberately not done**: `LabOrder`/`ImagingOrder` were not
retrofitted with an `orderId` link this phase (their creation routes
weren't touched — see §9), and `OrderType` declares `PROCEDURE`/`BLOOD`/
`DIETARY` values with **zero rows** this phase — forward-declared
extensibility, not a claim those modules exist (brief §47 explicitly
excludes OT/blood bank/dietary systems this phase).

**Nursing orders** reuse `Task` (already deepened this phase, §5) as the
detail table when `Order.orderType = NURSING`, via `Task.orderId` —
avoiding a fifth near-identical child table for something the existing
task engine already models completely.

## 2. Doctor OS

`src/components/hospital-os/DoctorWorkspace.tsx` gained a live metrics
row (`GET /api/hospital/doctor/dashboard`) — admitted patients, pending/
critical lab and imaging results, unsigned notes, medications needing
attention (HELD/REJECTED), pending consults, discharge candidates — every
number a facility-scoped (optionally staff-scoped) Prisma aggregate, no
placeholder. The existing "My queue" (Phase 2) and encounter list
(Phase 0) are unchanged.

`PatientChart.tsx` (the encounter workspace, Phase 0/1) gained: medication
status badges with per-order safety-warning counts, a Care Plan tab, a
"Request handoff" action, and an expanded note-type selector (PROGRESS/
CONSULT/ADMISSION/DAILY_ROUND/PROCEDURE/DISCHARGE_SUMMARY/FOLLOW_UP/
HANDOVER) with a working amend flow (see §3).

## 3. Clinical note lifecycle (brief §4-5)

`ClinicalNote` (Phase 0) gained `authorRole` (denormalized at creation —
a later role change never retroactively rewrites history), `amendedAt`,
`amendmentReason`. The existing DRAFT → SIGNED → SUPERSEDED mechanism
(Phase 1) is unchanged; amending now **requires** a reason
(`POST .../notes` with `supersedesId` + `amendmentReason`), recorded on
the *old* note when it flips to SUPERSEDED. `hospital.note.signed` and
`hospital.note.amended` are new, more specific audit events replacing the
generic `hospital.note.created` for those two actions.

Structured documentation (brief §5) uses the existing `content: Json`
field — no schema change. A note's `content` may hold any of
`presentingComplaint`/`hpi`/`pastMedicalHistory`/`surgicalHistory`/
`familyHistory`/`socialHistory`/`examination`/`assessment`/`diagnosis`/
`treatmentPlan`/`investigationPlan`/`medicationPlan`/`followUpPlan` as
optional keys, or just free narrative — never a rigid form.

## 4. Care plan (brief §6)

New `CarePlan`/`CarePlanIntervention` models — problem/goal/interventions,
with `responsibleRole` as free text (same convention as `Task.type`, not
a closed set). Never invents thresholds or protocols: `goal` and every
intervention `description` are entirely clinician-authored strings. Live
example seeded and verified: "Pneumonia" → "Maintain SpO2 within the
facility-configured target range" → four nursing/radiology interventions.

## 5. Task engine deepening (brief §12)

`Task` (Phase 1) gained `startedAt`, `skippedAt`, `skipReason`,
`recurrenceRule` (free-text description, e.g. "every 4h" — **no
recurrence-generation engine was built**; a recurring task is still one
row a human re-creates, not an auto-spawning schedule), and `orderId`
(the nursing-order link from §1). Task *types* remain an open string
vocabulary by design (brief's own "avoid hardcoding every task type into
frontend conditionals, use extensible task definitions") — the UI renders
generically off `title`/`type`/`priority`/`dueAt`, no per-type switch
statement.

## 6. Specialist consult (brief §8) — reused `Referral`, not duplicated

Phase 1's `Referral` model already implemented `DRAFT → PLACED →
ACKNOWLEDGED → IN_PROGRESS → COMPLETED/CANCELLED/REJECTED` with
requesting/assigned staff, urgency, and reason. Phase 3 added exactly one
field, `acceptedAt` (distinguishing "accepted, now being worked" from
"closed" — `respondedAt` alone couldn't), and two new audit events
(`hospital.consult.accepted`, `hospital.consult.completed`) fired from
the existing `PATCH /api/hospital/referrals/[id]` route. No new consult
model was built.

## 7. Clinical handoff (brief §9/§26) — one model, two roles

`ClinicalHandoff` serves both doctor and nurse handoffs (`type: DOCTOR |
NURSE`, distinguished by the actual role of the participating staff, not
a second model) — avoiding the duplicate-business-logic the brief
explicitly warns against for two structurally identical workflows. A
handoff starts `PENDING` and can only become `ACKNOWLEDGED` through an
explicit action — it is a real database row, never silently dropped;
re-acknowledging an already-acknowledged handoff is rejected
(live-verified: 400, "already been acknowledged").

## 8. Nursing assignment (brief §11)

`NursingAssignment` — facility/department/bed-scoped, one open
(`endAt: null`) assignment per patient at a time; assigning a new nurse
automatically closes the prior open assignment (`endAt` set) rather than
mutating or deleting it — full history preserved and queryable
(`GET .../nurse/assignments?history=true`).

## 9. Medication lifecycle (brief §15-16) — the core of this phase

`MedicationOrder.status` was converted from a loose string
(`"ORDERED" | "VERIFIED" | "DISPENSED" | "DISCONTINUED" | "HELD"`, no
server-enforced transitions) to a real, server-validated enum:

```
DRAFT → ORDERED → PHARMACY_REVIEW → VERIFIED → DISPENSED → ACTIVE → COMPLETED
                        │                │           │         │
                        ├→ REJECTED ─────┘           │         │
                        ├→ HELD ─────────────────────┘         │
                        └→ CANCELLED (from DRAFT/ORDERED/PHARMACY_REVIEW/VERIFIED)
                     DISCONTINUED reachable from any non-terminal state
```

**Why this one conversion was safe** (and `LabOrder`/`ImagingOrder`/
`Referral`/every other Phase 0-2 status field was deliberately left
alone): every existing `MedicationOrder` row's status was verified
(`SELECT status, count(*) ... GROUP BY status`) to be exactly `"ORDERED"`
before the migration — itself a member of the new enum — so no row's
meaning changed. `src/lib/hospital/medicationLifecycle.ts` is the single
service every medication-order mutation goes through; illegal
transitions throw `InvalidMedicationOrderTransitionError`, live-verified
(e.g. `DISCONTINUED → VERIFIED` rejected with a 400).

Every order is auto-submitted to `PHARMACY_REVIEW` immediately after
creation — "every order goes to pharmacy for review" is the default, not
an extra step a doctor must remember.

`MedicationAdministration.status` also became a real enum
(`DUE | GIVEN | HELD | REFUSED | MISSED | CANCELLED`). `GIVEN` was kept
(not renamed to `ADMINISTERED`, despite brief §20's example vocabulary)
because it's the exact string every existing route, seed row, and UI
filter already reads — renaming it would be the "destructive rewrite"
this phase is explicitly told not to do, for a purely cosmetic gain.
`REFUSED` and `CANCELLED` are the genuinely new states.

## 10. Medication safety (brief §18)

`src/lib/hospital/clinicalSafety.ts` (Phase 0) gained two new rules —
`route-mismatch` and `frequency-mismatch` — both, like the original two
rules, derived **only from this patient's own recorded allergies and
active orders**, never external drug-interaction/class knowledge. A live
test with allergy substance `"sulfa drugs"` vs. ordered drug
`"Sulfamethoxazole"` produced **no match** — confirming the engine
doesn't infer drug-class membership it was never given; only an
exact/substring literal match on `"ibuprofen"` vs. an `"ibuprofen"`
allergy correctly triggered a DANGER block. This is the documented,
honest boundary (see the file's own comment), not a bug.

New `MedicationSafetyWarning` table makes every flag individually
acknowledgeable/overridable with actor + timestamp — Phase 0's
`MedicationOrder.safetyFlags` JSON snapshot is left untouched for
backward compatibility; the new table is the actionable, auditable
version. A DANGER warning without an override reason blocks order
creation (`{ blocked: true, flags }`, never a silent allow); overriding
requires a reason and is itself audited
(`hospital.medication.safetyOverridden`).

## 11. Pharmacist verification (brief §17)

`MedicationVerification` — one row per pharmacist decision
(VERIFIED/REJECTED/HOLD/CLARIFICATION_REQUESTED), reason required for
anything but VERIFIED. `GET /api/hospital/pharmacy/queue` gives the
pharmacist full context per order: allergies, active problems, other
current medications, and this order's own unacknowledged safety
warnings — not a bare drug name. Live-verified full Scenario D (brief
§44): CLARIFICATION_REQUESTED → doctor corrects and resubmits
(`PATCH .../resubmit`, REJECTED/HELD → PHARMACY_REVIEW) → VERIFIED.

## 12. Dispensing (brief §23-25)

`DispensingRecord` — full/partial/substituted/returned/cancelled, with
`batchNumber`/`expiryDate` nullable (captured when available, never
fabricated) and a `witnessStaffId` co-sign hook for controlled
medications. **Controlled-medication handling is a single
`MedicationOrder.isControlled` boolean, not a jurisdiction-specific rule
engine** (brief §25's explicit "do not invent jurisdiction-specific
legal requirements... make regulatory rules configurable") — when true,
both `dispenseMedication()` and `administerMedication()` require a
`witnessStaffId` or reject the action. Substitution requires
`substitutedDrugName` — never a silent swap. Dispensing a full quantity
auto-transitions the order `VERIFIED → DISPENSED → ACTIVE` in one
transaction (a deliberate simplification: nothing this phase
distinguishes "dispensed, not yet active" from "active," so collapsing
them avoids an extra manual step with no consumer).

## 13. MAR and the bedside workflow (brief §20-21)

`administerMedication()` is the single entry point for every MAR status
change. It is transactional and concurrency-safe: it re-checks the
administration row's own status *inside* its transaction before writing,
so a double-click or two nurses racing the same dose cannot both
succeed — **live-verified** by firing two simultaneous requests at the
same DUE dose: exactly one succeeded (200, `GIVEN`), the other was
rejected (400, "already GIVEN"). It also re-checks the order's own status
(rejecting administration of a HELD/CANCELLED/DISCONTINUED/REJECTED
order — live-verified against a VERIFIED-but-not-yet-dispensed order).

`NurseTasks.tsx` (the bedside screen) keeps the flow to the brief's
explicit sequence: open the due-medication card → confirm the safety
checklist → (witness id if controlled) → Give/Hold/Refuse, all inline,
no page navigation required.

## 14. Reconciliation (brief §19)

`MedicationReconciliation` — purely additive rows keyed by
`source: ADMISSION | TRANSFER | DISCHARGE` and
`decision: CONTINUED | MODIFIED | STOPPED | NEW`. Never deletes or
mutates any `MedicationOrder` row; a reconciliation decision is a new,
separate record of a review having happened.

## 15. Vitals, abnormal detection, and I/O (brief §13-14)

`Vital` gained `consciousness` (free text — no GCS/AVPU scale is
implemented or implied), `o2DeliveryMethod`, `o2FlowRate`. Abnormal-vital
detection (`src/lib/hospital/vitalsThresholds.ts`) reads a new
`VitalThreshold` table — **exactly the same pattern as Phase 2's
`SlaPolicy`**: a metric with no configured threshold row generates no
alert, ever. Demo thresholds are seeded as explicit, labeled example
values, not hardcoded in application logic.

`IntakeOutputRecord` — INPUT (ORAL/IV/ENTERAL/OTHER) and OUTPUT
(URINE/DRAIN/EMESIS/STOOL/OTHER), with a shift/day summary computed at
read time (sum by type/category over a `since` window) — never stored,
same aggregation pattern used everywhere in this codebase since Phase 1.

## 16. Pharmacy Workspace

New `/hospital-os/pharmacy` (`PharmacyWorkspace.tsx`) — dashboard tiles
(pending verification, urgent, rejected, clarification requests,
dispensing queue, controlled queue, delayed) plus the verification queue
itself with inline verify/reject/hold/clarify and dispense actions.

## 17. Command Center and alert engine extensions (brief §27/§32)

`getCommandCenterSnapshot()` gained a `clinicalOps` section (doctor/
nursing/pharmacy metrics, all live aggregates — see §2). `computeAlerts()`
gained: overdue medication, overdue nursing task, unresolved DANGER
safety warning, pharmacist-review-pending-too-long, and
clarification-requested alerts — all live-verified against real seeded
data (e.g. a deliberately 90+-minute-overdue medication surfaced as a
critical alert).

## 18. RBAC (brief §33)

New permissions: `carePlan:manage`, `handoff:manage`,
`nursing:assignment:manage`, `medication:dispense`,
`medication:discontinue`, `io:record`. Ordering/administering/signing/
vitals/tasks reuse the **existing** `clinical:order:medication` /
`medication:administer` / `clinical:note:*` / `vital:record` / `task:*`
permissions unchanged — no duplicate authorization surface for the same
action. `medication:verify` already existed (Phase 0, granted to
`PHARMACIST`) but had zero enforcement point until this phase's pharmacy
workflow actually checks it.

## 19. Audit (brief §34)

~24 new `AuditEventType` values (note signed/amended, order created/
cancelled/discontinued, medication verified/rejected/held/dispensed/
refused/missed/safety-overridden/reconciled, nursing assignment changed,
task skipped, handoff created/acknowledged, care plan created/closed,
consult accepted/completed, vital abnormal-detected) — recorded through
the same synchronous `recordAuditEvent()`/`tx.auditEvent.create()`
mechanism as every prior phase. No new event bus.

## 20. Concurrency (brief §36)

| Scenario | Mechanism | Verified |
|---|---|---|
| Duplicate medication administration | `administerMedication()` re-checks the administration row's status inside its own transaction | Live: two simultaneous requests, one 200 + one 400 |
| Concurrent pharmacist verification | `transition()` re-fetches the order and checks legality inside the transaction before writing | Structural (same pattern as the encounter/bed state machines) |
| Order cancellation vs. administration race | `administerMedication()` re-checks `medicationOrder.status` inside its transaction | Live: administering a not-yet-dispensed order rejected |
| Bed reservation (Phase 2, unchanged) | `transitionBed()` inside `$transaction` | Re-verified this phase, unaffected |

Same caveat as Phase 2: these are application-level transactional
checks, safe under SQLite's serialized single-connection transactions;
a Postgres deployment under real concurrent load should additionally
take a row lock, noted as a Phase 4+ hardening item.

## 21. PostgreSQL migration considerations

No Phase 3 addition uses a SQLite-specific type. `Json` fields
(`MedicationOrder.safetyFlags`, `ClinicalNote.content`) map directly to
Postgres `jsonb`. All new enums (`OrderType`, `OrderStatus`,
`MedicationOrderStatus`, `MedicationAdministrationStatus`,
`SafetySeverity`, `VerificationDecision`, `DispenseStatus`,
`ReconciliationSource`, `ReconciliationDecision`, `CarePlanStatus`,
`InterventionStatus`, `HandoffType`, `HandoffStatus`, `IOType`) become
real Postgres `ENUM` types automatically — a strict improvement over
SQLite, where Prisma enums are just `TEXT` with application-level
validation only.

## 22. Future inventory integration (brief §24)

`DispensingRecord` already carries `batchNumber`/`expiryDate` — the
minimum fields a real inventory/stock-ledger integration would need to
consume — but no stock table, purchase order, supplier, or ward-stock
model was built (brief §47 non-goal). A future inventory phase can add a
`Stock`/`Batch` table and have `DispensingRecord` reference it without
touching the medication lifecycle state machine itself.

## 23. What's explicitly deferred to Phase 4+

- `LabOrder`/`ImagingOrder` linking to the generalized `Order` table (the
  pattern is proven once on `MedicationOrder`/`Referral`; extending it to
  Lab/Radiology is low-risk, additive work, just not done this phase).
- A recurrence-generation engine for tasks (currently free-text only).
- Real drug-interaction/contraindication reference data (the engine is
  architected to accept it — see `clinicalSafety.ts`'s own comments —
  but none is fabricated).
- A jurisdiction-specific controlled-substance regulatory engine (a
  single boolean flag today).
- Inventory/stock/batch tracking beyond the two fields on
  `DispensingRecord`.
- A formal escalation/department-lead chain beyond alert `ownerRole` +
  severity (unchanged limitation from Phase 2).
