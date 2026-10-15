# Workflow spine: design (Week 3, phase A)

- **Status:** Draft for review. Nothing in this document is implemented yet.
- **Date:** 2026-10-15
- **Builds on:** ADR 0004 (modules sync through transactional domain events),
  `src/lib/events` (outbox, delivery ledger, catalogue, dispatcher) and
  `src/lib/workflows` (engine, timers, workflow tasks).

> **Source of the planned events.** The brief asks for "the 36 planned events
> (see the plan's Section 4 table)". That table is not in the repository or in
> this working session; the only catalogue in the repo is the illustrative one
> in `docs/EVENT_ARCHITECTURE.md` §4. The 36 planned events in §1.2 were
> therefore **derived from the code**: one event per state change on the core
> journey and its billing tail, each tied to the existing service function that
> makes the change. Please reconcile §1.2 against the plan's table during
> review. Names, splits or merges can change without affecting the rest of the
> design.

## Contents

1. Event catalogue (18 existing + 36 planned)
2. Consumers
3. Background runner
4. D6: one Task model
5. How charges move (no double charging)
6. CI enforcement: state changes must emit
7. Core-journey replay test
8. Risks
9. Order of wiring

---

## 1. Event catalogue

### 1.0 Conventions (all events)

- **Emission.** `emitDomainEvent(tx, …)` with the **same `tx`** as the state
  change (ADR 0004 rule 1). Never the global client while a write is open.
- **Envelope** (already in `DomainEventOutbox`): `eventId`, `eventType`,
  `eventVersion`, `aggregateType`, `aggregateId`, `organizationId`,
  `facilityId`, `actorUserId`, `correlationId`, `causationId`, `occurredAt`.
  These are not repeated in the payload tables below.
- **Payload.** IDs plus closed-set codes and booleans only. No names, no
  free text, no clinical values (no results, doses, diagnoses text, notes).
  Amounts appear only on billing events, as integer minor units, as the
  existing contracts already do. Every payload is a strict Zod schema and
  passes `assertNoSensitiveData`.
- **Scope.** `FACILITY` (facilityId and organizationId set) or `ORGANIZATION`
  (organizationId only; SaaS billing).
- **Sensitivity** (existing scale in `src/lib/events/types.ts`):
  - `LOW`: commercial identifiers and amounts;
  - `INTERNAL`: clinical/operational IDs about a patient;
  - `SENSITIVE`: the fact itself is sensitive (consent, transfusion
    reaction, a missed dose), so operator views mask it and only
    clinical consumers receive it.
- **Correlation.** `correlationId` = the encounter ID for everything inside
  an encounter (so the replay test and the ops console can pull one
  patient journey); `causationId` = the `eventId` of the event a consumer
  was reacting to when it emitted (§2).
- **Version.** All new events start at version 1; changes are new versions
  (ADR 0004 rule 4).

### 1.1 Existing events (18)

All already emit inside the producer's transaction, except where noted.

| # | Event | Ver | Aggregate | Producer (file → function) | Transaction | Payload | Scope | Sensitivity |
|---|---|---|---|---|---|---|---|---|
| 1 | `PatientRegistered` | 1 | PATIENT | `src/app/api/hospital/patients/route.ts` → `POST` | the `createPatientWithUhid` tx | patientId, uhid? | FACILITY | INTERNAL |
| 2 | `AppointmentBooked` | 1 | APPOINTMENT | `src/lib/hospital/appointment.ts` → `bookAppointment` | the booking tx (under the doctor's advisory lock) | appointmentId, patientId, doctorStaffId, scheduledStart | FACILITY | INTERNAL |
| 3 | `AdmissionCreated` | 1 | ADMISSION | `src/lib/hospital/admission.ts` → `admitPatient` | the admission tx (bed CAS + location) | admissionId, encounterId, patientId, bedId? | FACILITY | INTERNAL |
| 4 | `MedicationOrdered` | 1 | MEDICATION_ORDER | `src/lib/hospital/medicationLifecycle.ts` → `createMedicationOrder` | the order + envelope tx | orderId, patientId, encounterId? | FACILITY | INTERNAL |
| 5 | `LabResultReleased` | 1 | LAB_RESULT | `src/lib/hospital/labResultLifecycle.ts` → `verifyResult` | the verify tx | resultId, orderId?, patientId?, critical? | FACILITY | INTERNAL |
| 6 | `ImagingReportReleased` | 1 | IMAGING_REPORT | `src/lib/hospital/imagingReportLifecycle.ts` → `verifyReport` | the verify tx | reportId, studyId?, patientId?, critical? | FACILITY | INTERNAL |
| 7 | `ConsentGranted` | 1 | CONSENT | `src/lib/consent/lifecycle.ts` → `grantConsent` | the grant tx | consentId, patientId | FACILITY | SENSITIVE |
| 8 | `ConsentRevoked` | 1 | CONSENT | `src/lib/consent/lifecycle.ts` → `revokeConsent` | the revoke tx | consentId, patientId | FACILITY | SENSITIVE |
| 9 | `SubscriptionActivated` | 1 | SUBSCRIPTION | `src/lib/commercial/subscriptions.ts` → `assignPlan` | assign tx | subscriptionId, planId, billingInterval | ORGANIZATION | LOW |
| 10 | `SubscriptionRenewed` | 1 | SUBSCRIPTION | `src/lib/commercial/subscriptions.ts` → `applyPaidRenewal` | renewal tx | subscriptionId, periodStart, periodEnd | ORGANIZATION | LOW |
| 11 | `SubscriptionCancelled` | 1 | SUBSCRIPTION | `src/lib/commercial/subscriptions.ts` → `cancelSubscription` | cancel tx | subscriptionId, immediate | ORGANIZATION | LOW |
| 12 | `InvoiceCreated` | 1 | INVOICE | `src/lib/billing/invoices.ts` → `generateInvoiceForPeriod` | generation tx | invoiceId, totalMinor, currency | ORGANIZATION | LOW |
| 13 | `InvoiceFinalized` | 1 | INVOICE | `src/lib/billing/invoices.ts` → `finalizeInvoiceTx` | caller's tx | invoiceId, invoiceNumber, totalMinor, currency | ORGANIZATION | LOW |
| 14 | `PaymentReceived` | 1 | PAYMENT | `src/lib/billing/payments.ts` → `recordPayment` | the idempotent insert tx | paymentId, invoiceId, amountMinor, currency | ORGANIZATION | LOW |
| 15 | `PaymentFailed` | 1 | PAYMENT | **no producer today** (declared for `billing/payments` / webhooks) | — | attemptId, invoiceId?, amountMinor, currency, failureCode? | ORGANIZATION | LOW |
| 16 | `RefundIssued` | 1 | REFUND | `src/lib/billing/refunds.ts` → `refundPaymentTx` | caller's tx | refundId, paymentId, amountMinor, currency | ORGANIZATION | LOW |
| 17 | `ReconciliationExceptionCreated` | 1 | RECONCILIATION_EXCEPTION | `src/lib/commercial/analytics/leakage.ts` → `createFinding` | finding tx | exceptionId, kind, severity, source | ORGANIZATION | LOW |
| 18 | `ReconciliationExceptionResolved` | 1 | RECONCILIATION_EXCEPTION | `src/lib/commercial/analytics/reconciliationIntel.ts` → `transitionException` | transition tx | exceptionId, status | ORGANIZATION | LOW |

Findings while cataloguing:

- **`PaymentFailed` is never emitted.** Phase B wires it from the payment-
  attempt failure path in `src/lib/billing/payments.ts` and the webhook
  handler, in the same transaction that marks the attempt FAILED.
- **`PatientRegistered` is emitted from a route handler**, not a service.
  Phase B moves registration into `src/lib/patient/registration.ts →
  registerPatient(tx, …)` so the CI rule in §6 can see it.
- **The workflow engine's `runAction` (`src/lib/workflows/engine.ts`) emits
  through the global client** (`emitDomainEvent(prisma, …)`), outside the
  step's transaction. Phase B passes the step's `tx` (ADR 0004 rule 1).

### 1.2 Planned events (36)

Producers named `(new service)` are a state change currently made inside a
route handler; phase B moves it into the named service function first, so the
event is emitted from the service. Everything else already has the service
function and gains one `emitDomainEvent(tx, …)` call in its existing
transaction.

**ADT and access (12)**

| # | Event | Aggregate | Producer (file → function) | Transaction | Payload | Sens. |
|---|---|---|---|---|---|---|
| 19 | `EncounterOpened` | ENCOUNTER | `src/lib/hospital/encounter.ts` → `openEncounter` (new service; today `api/hospital/encounters` POST) | encounter create | encounterId, patientId, encounterType, accessSource | INTERNAL |
| 20 | `EdArrivalRegistered` | ENCOUNTER | `src/lib/hospital/emergency.ts` → `registerEdArrival` | encounter + ED location tx | encounterId, patientId, arrivalMode?, traumaIndicator | INTERNAL |
| 21 | `PatientCheckedIn` | APPOINTMENT | `src/lib/hospital/appointment.ts` → `checkInAppointment` | check-in tx | appointmentId, patientId, encounterId? | INTERNAL |
| 22 | `AppointmentCancelled` | APPOINTMENT | `src/lib/hospital/appointment.ts` → `cancelAppointment` | cancel tx | appointmentId, patientId, byPatient | INTERNAL |
| 23 | `PatientTriaged` | ENCOUNTER | `src/lib/hospital/triage.ts` → `recordTriage` | triage tx (status COMPLETED only, not DRAFT) | triageId, encounterId, patientId, acuity (1–5) | INTERNAL |
| 24 | `AdmissionRequested` | ADMISSION_REQUEST | `src/lib/hospital/admissionRequest.ts` → `createAdmissionRequest` | request tx | admissionRequestId, encounterId, patientId, priority | INTERNAL |
| 25 | `BedReserved` | ADMISSION_REQUEST | `src/lib/hospital/admissionRequest.ts` → `allocateBed` | bed CAS + reservation tx | admissionRequestId, bedId | INTERNAL |
| 26 | `PatientTransferred` | ADMISSION | `src/lib/hospital/admission.ts` → `transferPatientInTx` | the transfer tx (also when called by `completeTransferRequest`) | transferId, admissionId, encounterId, fromLocationId?, toLocationId | INTERNAL |
| 27 | `IcuAdmitted` | ADMISSION | `src/lib/hospital/icu.ts` → `admitToIcu` (direct ICU admission) and `transferWithinIcu` (when the patient moves from a non-ICU bed into an ICU bed) | the admission tx / the transfer tx | admissionId, encounterId, patientId, icuUnitId, viaTransfer | INTERNAL |
| 28 | `DischargeInitiated` | DISCHARGE | `src/lib/hospital/admission.ts` → `initiateDischarge` (moves into a tx) | discharge create | dischargeId, admissionId, encounterId | INTERNAL |
| 29 | `PatientDischarged` | DISCHARGE | `src/lib/hospital/admission.ts` → `finalizeDischarge` | finalize tx (bed release, bed-day charges) | dischargeId, admissionId, encounterId, patientId | INTERNAL |
| 30 | `EncounterClosed` | ENCOUNTER | `src/lib/hospital/encounterStateMachine.ts` → `transitionEncounter` (to a terminal status) | transition tx | encounterId, patientId, toStatus | INTERNAL |

**Orders, results, medication (8)**

| # | Event | Aggregate | Producer (file → function) | Transaction | Payload | Sens. |
|---|---|---|---|---|---|---|
| 31 | `LabOrderPlaced` | LAB_ORDER | `src/lib/hospital/labOrder.ts` → `placeLabOrder` (new service; today `api/hospital/orders/lab` POST) | order + envelope + specimen tx | labOrderId, orderId, encounterId, patientId, priority, catalogTestId? | INTERNAL |
| 32 | `ImagingOrderPlaced` | IMAGING_ORDER | `src/lib/hospital/imagingOrder.ts` → `placeImagingOrder` (new service; today `api/hospital/orders/imaging` POST) | order + envelope tx | imagingOrderId, orderId, encounterId, patientId, priority, modality | INTERNAL |
| 33 | `SpecimenCollected` | SPECIMEN | `src/lib/hospital/specimenLifecycle.ts` → `collectSpecimen` | collect tx (with D9 `syncOrderStatus`) | specimenId, labOrderId, patientId | INTERNAL |
| 34 | `ImagingStudyCompleted` | IMAGING_STUDY | `src/lib/hospital/imagingStudyLifecycle.ts` → `completeStudy` | complete tx | studyId, imagingOrderId, patientId | INTERNAL |
| 35 | `MedicationVerified` | MEDICATION_ORDER | `src/lib/hospital/medicationLifecycle.ts` → `verifyMedicationOrder` | verify tx | orderId, patientId, encounterId? | INTERNAL |
| 36 | `MedicationDispensed` | DISPENSING_RECORD | `src/lib/hospital/medicationLifecycle.ts` → `dispenseMedication` and `src/lib/hospital/pharmacy.ts` → `dispenseFromPharmacy` | dispense tx | dispensingRecordId, orderId, patientId, encounterId?, quantity, partial | INTERNAL |
| 37 | `MedicationAdministered` | MEDICATION_ADMINISTRATION | `src/lib/hospital/medicationLifecycle.ts` → `administerMedication` (status GIVEN) | administer tx | administrationId, orderId, patientId, encounterId? | INTERNAL |
| 38 | `MedicationDoseMissed` | MEDICATION_ADMINISTRATION | `administerMedication` (status MISSED) and the MAR sweep (§3.4) | administer tx / sweep tx | administrationId, orderId, patientId, scheduledAt, missedBy: NURSE \| SWEEP | SENSITIVE |

**Operating theatre (5)**

| # | Event | Aggregate | Producer (file → function) | Transaction | Payload | Sens. |
|---|---|---|---|---|---|---|
| 39 | `SurgeryRequested` | SURGERY | `src/lib/hospital/surgery.ts` → `requestSurgery` | request tx | surgeryId, encounterId, patientId, procedureId, urgency | INTERNAL |
| 40 | `SurgeryScheduled` | SURGERY | `src/lib/hospital/surgery.ts` → `scheduleSurgery` | schedule tx (no-overlap EXCLUDE) | surgeryId, scheduleId, operatingTheatreId, startAt, endAt | INTERNAL |
| 41 | `ProcedureStarted` | SURGERY | `src/lib/hospital/surgery.ts` → `startProcedure` | start tx | surgeryId, encounterId, patientId | INTERNAL |
| 42 | `ProcedureCompleted` | SURGERY | `src/lib/hospital/surgery.ts` → `completeProcedure` | complete tx | surgeryId, encounterId, patientId, procedureId, durationMinutes | INTERNAL |
| 43 | `SurgeryItemUsed` | SURGERY | `src/lib/hospital/surgery.ts` → `recordItemUsage` | usage tx | usageId, surgeryId, itemId, quantity | INTERNAL |

**Blood bank (3)**

| # | Event | Aggregate | Producer (file → function) | Transaction | Payload | Sens. |
|---|---|---|---|---|---|---|
| 44 | `BloodIssued` | BLOOD_ISSUE | `src/lib/hospital/blood.ts` → `issueUnit` | issue tx | issueId, unitId, requestId, patientId | INTERNAL |
| 45 | `TransfusionStarted` | TRANSFUSION | `src/lib/hospital/blood.ts` → `startTransfusion` | start tx | transfusionId, unitId, requestId, patientId | INTERNAL |
| 46 | `TransfusionReactionReported` | TRANSFUSION | `src/lib/hospital/blood.ts` → `reportReaction` | report tx | reactionId, transfusionId, patientId, severity | SENSITIVE |

**Nursing and documentation (3)**

| # | Event | Aggregate | Producer (file → function) | Transaction | Payload | Sens. |
|---|---|---|---|---|---|---|
| 47 | `TaskCreated` | TASK | `src/lib/hospital/task.ts` → `createTask` (new; the unified Task of §4) | create tx | taskId, source, taskType, patientId?, encounterId?, priority, dueAt? | INTERNAL |
| 48 | `TaskCompleted` | TASK | `src/lib/hospital/task.ts` → `completeTask` / `skipTask` | complete tx | taskId, source, outcome: COMPLETED \| CANCELLED | INTERNAL |
| 49 | `ClinicalNoteSigned` | CLINICAL_NOTE | `src/lib/hospital/clinicalNote.ts` → `signNote` | sign tx | noteId, encounterId, patientId, noteType | INTERNAL |

**Hospital billing and claims (5)**

| # | Event | Aggregate | Producer (file → function) | Transaction | Payload | Sens. |
|---|---|---|---|---|---|---|
| 50 | `ChargePosted` | CHARGE | `src/lib/hospital/billing/chargeCapture.ts` → `createCharge` (every path, including `createChargeIfNotExists` when it inserts) | the caller's tx | chargeId, encounterId, patientId, sourceType?, sourceId?, netAmountMinor, currency | LOW |
| 51 | `HospitalInvoiceIssued` | HOSPITAL_INVOICE | `src/lib/hospital/billing/invoices.ts` → `issueInvoice` | issue tx | invoiceId, encounterId?, patientId, totalMinor, currency | LOW |
| 52 | `HospitalPaymentRecorded` | HOSPITAL_PAYMENT | `src/lib/hospital/billing/payments.ts` → `recordPayment` | the idempotent insert tx | paymentId, billingAccountId, patientId, amountMinor, currency | LOW |
| 53 | `ClaimDrafted` | CLAIM | `src/lib/hospital/billing/claims.ts` → `createClaimDraft` | draft tx | claimId, invoiceId, coverageId, patientId | LOW |
| 54 | `ClaimSubmitted` | CLAIM | `src/lib/hospital/nhcx/submission.ts` → `dispatchSubmission` | the exchange create tx | claimId, submissionId, exchangeId, version | LOW |

All planned events are `FACILITY` scope. `MedicationDoseMissed` and
`TransfusionReactionReported` are `SENSITIVE` because the fact itself is
clinically sensitive; operator views (`ops.ts`) show their type and IDs only.

---

## 2. Consumers

Today there are two: `observability-projection` (`*`, no side effect) and
`workflow-engine` (`*`, starts workflows). The table adds the Week 3
consumers. Every consumer:

- re-reads what it needs through the owning module's service and re-checks
  the event's tenant on every row (ADR 0004 rules 2 and 5);
- is idempotent under redelivery through a natural key enforced by a unique
  constraint (never check-then-write);
- emits its own follow-on events, if any, in its own transaction with
  `causationId = eventId`;
- classifies errors: a retryable error (DB timeout, lock contention, a
  not-yet-visible row) → **RETRY** with the existing exponential backoff
  (30 s doubling, capped at 1 h); a permanent error (contract mismatch,
  missing price, a row the tenant can't see) → **DEAD_LETTER**, visible in
  `listDeadLetters` and replayable after a fix (`replay.ts`).

"Ordered" means the consumer must see events of one aggregate in emission
order (§3.3).

| Consumer | Subscribes to | Writes | Idempotency key | Failure / retry / dead letter | Ordered per aggregate |
|---|---|---|---|---|---|
| `observability-projection` (exists) | `*` | nothing (the delivery row is the projection) | (eventId, consumer) ledger row | cannot fail | no |
| `workflow-engine` (exists) | `*` | `WorkflowInstance`, steps, timers, tasks | `WorkflowInstance.idempotencyKey` derived from (definition, eventId) | retry; dead letter on an invalid definition | **yes** (by correlationId) |
| `charge-capture` | `ProcedureCompleted`, `SurgeryItemUsed`, `BloodIssued`, `PatientTriaged` (ED triage fee where tariffed), `EncounterOpened` (consultation fee where tariffed), `IcuAdmitted` (ICU admission fee) | `Charge` via `createPricedChargeIfNotExists` | `Charge (sourceType, sourceId)` unique: e.g. (`Surgery`, surgeryId), (`SurgeryItemUsage`, usageId), (`BloodIssue`, issueId) | `PriceNotFoundError` → posts the zero-priced "needs pricing" charge exactly as the in-tx paths do today (never blocks, never silently skips); DB errors retry; a charge on an invoiced encounter → dead letter + reconciliation exception | no (each charge is keyed by its own source) |
| `stock-movement` | `SurgeryItemUsed`, `MedicationDispensed` (only for the paths migrated per §5.3) | `StockLedgerEntry` via `inventory/issue` | ledger `(sourceType, sourceId)` unique (already used by `postLedgerEntry`) | insufficient stock → dead letter + an inventory exception task (the clinical act already happened; we never roll it back) | no |
| `task-generator` | `AdmissionRequested`, `BedReserved`, `DischargeInitiated`, `LabResultReleased` (critical only), `ImagingReportReleased` (critical only), `MedicationDoseMissed`, `TransfusionReactionReported` | `Task` (source `EVENT`) | `Task.idempotencyKey = <consumer>:<eventId>:<taskType>` (unique, new column; §4) | retry; dead letter if the patient/encounter is not visible in the tenant | no |
| `notification-dispatch` | critical `LabResultReleased` / `ImagingReportReleased`, `TransfusionReactionReported`, `MedicationDoseMissed`, `TaskCreated` (STAT only) | `Notification` | `Notification (sourceEventId, recipientUserId)` unique (new) | retry; recipient no longer active → processed with no notification | no |
| `discharge-readiness` | `LabResultReleased`, `ImagingReportReleased`, `MedicationDispensed`, `HospitalInvoiceIssued`, `HospitalPaymentRecorded`, `ClaimDrafted`, `TaskCompleted` | `Discharge` readiness flags via `updateDischargeReadiness` | absolute recompute (the flags are a pure function of current state, so redelivery converges) | retry | **yes** (per admission: a late-arriving older event must not overwrite a newer recompute; recompute reads current state, so ordering only matters for the audit trail) |
| `claim-drafting` | `HospitalInvoiceIssued` (encounter with ACTIVE coverage) | `Claim` draft via `createClaimDraft` | `Claim (invoiceId)` unique for non-void claims (existing guard, made a partial unique index) | no coverage → processed, nothing written; preauth missing → draft with a blocker (never submitted automatically) | no |
| `abdm-care-context` | `PatientDischarged`, `LabResultReleased`, `ImagingReportReleased` (patients with a linked ABHA and a live consent) | `HealthInformationExchange` (OUTBOUND, REQUESTED) via `requestExchange` | HIE `(facilityId, idempotencyKey)` with key = `care-context:<eventId>` | consent revoked → processed, nothing sent (re-checked through `@/lib/consent`); ABDM down → retry | **yes** (per patient) |
| `mar-scheduler` | `MedicationVerified` | `MedicationAdministration` schedule rows (status SCHEDULED) | `(medicationOrderId, scheduledAt)` unique (new) | retry; order no longer active when it runs → processed, nothing scheduled | **yes** (per order) |

Note on `mar-scheduler`: today `generateAdministrationSchedule` runs right
after `createMedicationOrder` commits (outside its transaction). Phase B
moves schedule generation onto `MedicationVerified` (a dose is only
scheduled once pharmacy has verified it) and makes it idempotent on
`(medicationOrderId, scheduledAt)`. Discontinue/cancel stop the schedule in
their own transaction (they mark future PENDING doses CANCELLED), because a
patient must never be shown a dose due for a stopped drug while an event
waits in the queue (rule 6 of ADR 0004: an invariant that must hold now).

---

## 3. Background runner

### 3.1 One loop, three jobs

`src/lib/runner/tick.ts → runTick({ now, budgetMs })` runs, in order, each
bounded by its own batch size and the shared time budget:

1. `dispatchPendingDomainEvents({ batchSize: 100 })`
2. `tickWorkflows({ batchSize: 100 })` (timers, then runnable instances)
3. `sweepMedicationSchedule({ batchSize: 500 })` (§3.4)

It imports `@/lib/workflows/register` (and the new consumer registrations)
itself, so no entry point can run the dispatcher without the workflow
consumer, which is a trap today (the registration is a side-effect import in
one route).

**Local:** `npm run worker` → `scripts/worker.ts`: an infinite loop calling
`runTick({ budgetMs: 10_000 })`, sleeping 2 s when a tick did no work and
0 s when it hit a batch limit; it stops cleanly on SIGINT/SIGTERM after the
current tick. Development and the replay test use it.

**Staging/production:** `POST /api/cron/tick` (Vercel Cron, every minute;
Supabase is the database). Authenticated by `CRON_SECRET` in the
`Authorization` header (constant-time compare), not by a user session, and
refused unless `NODE_ENV=production` or `ALLOW_CRON_ROUTE=1`. `budgetMs:
50_000` keeps it inside the function limit. The existing platform-operator
routes (`enterprise/events/dispatch`, `enterprise/workflow-ops/tick`) stay as
manual triggers.

### 3.2 Batch size and concurrency

- Per tick: up to 100 events, 100 timers, 100 runnable instances, 500
  schedule rows; the time budget stops early.
- **Concurrency:** several ticks may run at once (overlapping cron
  invocations, a developer's worker against staging by mistake). Correctness
  never depends on a single runner; throughput does not need more than one.
- Within a tick, events are processed sequentially (simple, predictable
  database load at hospital volumes). Parallelism, if ever needed, is more
  workers, not threads.

### 3.3 Locking

Today the dispatcher claims with a guarded `UPDATE … WHERE status IN
(PENDING, RETRY)` plus a claim token. That is safe (one winner), but every
concurrent worker reads the same candidate list and loses most claims. Phase
B switches the claim to one statement:

```sql
UPDATE "DomainEventOutbox" o SET status = 'PROCESSING', "claimToken" = $token,
       "lastAttemptAt" = now(), "attemptCount" = o."attemptCount" + 1
WHERE o.id IN (
  SELECT id FROM "DomainEventOutbox"
  WHERE status IN ('PENDING', 'RETRY') AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
    AND NOT EXISTS (                         -- per-aggregate ordering, see below
      SELECT 1 FROM "DomainEventOutbox" e
      WHERE e."aggregateType" = "DomainEventOutbox"."aggregateType"
        AND e."aggregateId" = "DomainEventOutbox"."aggregateId"
        AND e."occurredAt" < "DomainEventOutbox"."occurredAt"
        AND e.status IN ('PENDING', 'RETRY', 'PROCESSING'))
  ORDER BY "occurredAt", id
  FOR UPDATE SKIP LOCKED
  LIMIT $batch)
RETURNING id;
```

- `FOR UPDATE SKIP LOCKED` lets concurrent workers take disjoint batches.
- **Per-aggregate ordering:** an event is not claimable while an older event
  of the same aggregate is still pending, retrying or in flight. This gives
  ordered delivery for every consumer at the cost of head-of-line blocking
  per aggregate (one patient's stuck event delays only that aggregate's
  later events, not the queue). A dead-lettered event no longer blocks its
  successors, because ordering is "process in order", not "never skip a
  failure"; consumers marked *ordered* re-read current state, so skipping a
  dead event cannot corrupt them.
- A crash between claim and finalize leaves a `PROCESSING` row. A stale-claim
  reaper inside `runTick` returns rows to `RETRY` when `lastAttemptAt` is older
  than 5 minutes (the delivery ledger stops processed consumers from running
  twice).
- Workflow timers get the same `FOR UPDATE SKIP LOCKED` claim; their existing
  CAS stays as the guard.

### 3.4 Workflow timers and MAR due/missed

- **Workflow timers** are already rows (`WorkflowTimer`, `availableAt`) fired by
  `tickWorkflows`; the runner simply calls it every tick. SLA escalation
  creates or escalates a Task (§4).
- **MAR due/missed** (new; today MISSED is only set by hand):
  `sweepMedicationSchedule(now)` finds `MedicationAdministration` rows still
  `SCHEDULED` whose `scheduledAt + graceMinutes` (configuration key
  `mar.missedGraceMinutes`, default 60) has passed. For each, in one
  transaction with a guarded update (`WHERE status = 'SCHEDULED'`):
  1. set status `MISSED` with `reasonCode = 'not-recorded'`;
  2. emit `MedicationDoseMissed` (`missedBy: SWEEP`).
  The `task-generator` and `notification-dispatch` consumers then create the
  follow-up task and alert. A nurse can still record the dose late; that
  writes a new administration row linked to the missed one, never rewriting
  it (the missed fact stays auditable).
- **Due soon** is not an event: it is a read (nurse task list query on
  `scheduledAt` within the next window), as today.

---

## 4. D6: one Task model

Today:

- `Task` (clinical; facility-scoped; owner is a staff profile; statuses OPEN,
  ASSIGNED, IN_PROGRESS, COMPLETED, CANCELLED, OVERDUE; created by the tasks
  route and care plans);
- `WorkflowTask` (engine; organization/facility; role or user assignment;
  OPEN, IN_PROGRESS, COMPLETED, CANCELLED, EXPIRED; `idempotencyKey`;
  belongs to a workflow instance/step).

Target: **one `Task`** with a `source` and optional workflow links.

| Field | Origin | Note |
|---|---|---|
| `source` | new enum `TaskSource` = MANUAL \| CARE_PLAN \| WORKFLOW \| EVENT \| ORDER | replaces the free-text `Task.source` |
| `workflowInstanceId`, `workflowStepId` | from WorkflowTask | nullable; set for `source = WORKFLOW` |
| `assignedRole`, `assignedUserId` | from WorkflowTask | role-based assignment; `ownerStaffId` stays for a named owner |
| `organizationId` | from WorkflowTask | nullable; facilityId becomes required (all workflow tasks the engine creates today are facility-scoped; an org-level task is refused by the migration if one exists) |
| `idempotencyKey` | from WorkflowTask | nullable, unique per (facilityId, key) like §8.4 |
| `status` | union | `TaskStatus` gains `EXPIRED`; `OVERDUE` is dropped as a status and becomes a derived view (`dueAt < now()` and open), because "overdue" is a time fact, not a state transition |
| `priority`, `dueAt`, `patientId`, `encounterId`, `completedAt`, `completedByUserId` | both | `completedByUserId` added; `completedByStaffId` kept for clinical sign-off |

Migration (phase B, one migration, refuse-don't-guess):

1. Add the new columns to `Task`; backfill `source` from the free text
   (`manual` → MANUAL, `care-plan`/`CarePlan…` → CARE_PLAN; anything else
   stops the migration and is named).
2. Copy every `WorkflowTask` into `Task` with `source = WORKFLOW`, the same
   id (so engine references stay valid), status mapped one-to-one, and the
   facility; a WorkflowTask without a facility stops the migration.
3. Repoint `src/lib/workflows/tasks.ts` (`createWorkflowTask`,
   `completeWorkflowTask`, `cancelWorkflowTask`) and `escalateSla` at `Task`;
   they keep their signatures, so the engine is unchanged.
4. Drop `WorkflowTask` once a gate shows every former row is reachable as a
   `Task` and the engine gate (`verify-postgres-d7-workflows`) passes.
5. Rows with status `OVERDUE` become `OPEN` (their `dueAt` already makes them
   overdue in the derived view); a row OVERDUE with no `dueAt` stops the
   migration.

All task lists (nurse tasks, workflow inbox, discharge prep) read one table.
`TaskCreated`/`TaskCompleted` are emitted by the one service, whatever the
source.

---

## 5. How charges move

### 5.1 Rule

A charge has exactly one natural source, and `Charge (sourceType, sourceId)`
is unique. **Whichever path posts it, the second attempt is a no-op**
(`createChargeIfNotExists` / `createPricedChargeIfNotExists` already do
`INSERT … ON CONFLICT DO NOTHING` on that key). So "no double charging" is a
database invariant, not a coordination promise, and holds even if an
in-transaction capture and a consumer both fire for the same source.

### 5.2 Who captures where

| Charge | Source key | Captured | Why |
|---|---|---|---|
| Lab test | (`LabOrder`, labOrderId) | **in-transaction** (stays) | price shown to the patient at ordering; financial clearance may block the order (rule 6: an invariant needed now) |
| Imaging study | (`ImagingOrder`, imagingOrderId) | **in-transaction** (stays) | same as lab |
| Pharmacy dispense | (`DispensingRecord`, recordId) | **in-transaction** (stays) | dispensing and stock issue must be atomic with the charge for controlled drugs; the pharmacist sees the amount |
| Bed-days | (`AdmissionBedDay`, admissionId) | **in-transaction** (stays) in `finalizeDischarge` | computed at discharge from the stay; part of the discharge invariant |
| Package | (`PackageApplication`, id) | in-transaction (stays) | applied by a biller explicitly |
| Surgery (procedure fee) | (`Surgery`, surgeryId) | **consumer** on `ProcedureCompleted` | new charge (none today) |
| Surgical consumables | (`SurgeryItemUsage`, usageId) | **consumer** on `SurgeryItemUsed` | new charge |
| Blood component | (`BloodIssue`, issueId) | **consumer** on `BloodIssued` | new charge |
| ICU admission fee | (`IcuAdmission`, admissionId) | **consumer** on `IcuAdmitted` | new charge |
| Consultation | (`Encounter`, encounterId) | **consumer** on `EncounterOpened` (OPD) | new charge, only where a tariff exists |
| ED triage fee | (`TriageAssessment`, triageId) | **consumer** on `PatientTriaged` | new charge, only where a tariff exists |

The existing in-transaction paths are **not** migrated to consumers in Week 3.
ADR 0004 allows migrating them one at a time later; when one is, the in-tx
call is removed in the same commit the consumer is added, and the shared
source key keeps the overlap window safe.

### 5.3 Example: no double charge

Lab order L-1 for patient P in encounter E, tariff 450.00 INR.

1. `placeLabOrder` (one tx): creates `LabOrder L-1`, calls
   `createPricedChargeIfNotExists(tx, { sourceType: "LabOrder", sourceId: "L-1", … })`
   → inserts `Charge C-1` (45 000 minor), emits `LabOrderPlaced` and
   `ChargePosted(C-1)`. Commit.
2. Suppose, mid-migration, a `charge-capture` consumer also handles
   `LabOrderPlaced`. It runs and calls the same function with
   (`LabOrder`, `L-1`) → `INSERT … ON CONFLICT ("sourceType","sourceId") DO
   NOTHING` inserts 0 rows → returns C-1, posts nothing, emits nothing.
3. The dispatcher redelivers `LabOrderPlaced` after a crash (at-least-once):
   the delivery ledger row is already PROCESSED, so the consumer is not even
   called; if it were, step 2 repeats with the same result.
4. The invoice drafted for E contains C-1 once. **Total for L-1: 450.00.**

The gate for each charge consumer (ADR 0004 cost: "Each consumer gets a
gate that redelivers the same event and asserts a single effect") does
exactly steps 2–3 and asserts `count(Charge where sourceType/sourceId) = 1`.

---

## 6. CI enforcement: a state change must emit

A unit test (`src/lib/events/emitCoverage.test.ts`, TypeScript compiler API,
like `src/app/api/errorStatus.test.ts`) over `src/lib/**`:

1. **Find state-changing service functions:** every exported function whose
   body (including nested callbacks) calls `create`, `createMany`, `update`,
   `updateMany`, `upsert`, `delete` or `deleteMany` on a Prisma delegate
   (`prisma.x` or `tx.x`), or a raw `INSERT`/`UPDATE`.
2. **Require an emit or an exemption:** the function (or a function it calls
   in the same file, one level deep) must call `emitDomainEvent`, **or** the
   function name must be in `src/lib/events/emitExemptions.ts` with a reason.
   Exemptions are for writes that are not domain facts:
   bookkeeping (`events/*`, `auth/audit`, delivery and timer claims), caches
   and projections, configuration drafts, sequences, and the read-model
   helpers. Each exemption names its category.
3. **Require the same transaction:** if a function uses `$transaction(async
   (tx) => …)`, the `emitDomainEvent` call must receive that callback's
   parameter, not `prisma` (catches the `runAction` bug in §1.1).
4. **Route handlers may not write domain tables directly:** a `route.ts` that
   calls a write method on a delegate other than through a service fails,
   except for an allowlist that shrinks to zero as phase B moves
   registration, encounter creation and order placement into services.

The test prints, for each failure, the function, file and line, and the
missing event. The exemption list is reviewed like code: adding to it needs
a reason that fits a category.

A second, runtime check backs it up: the replay test (§7) asserts the exact
event chain, so a producer that stops emitting fails CI even if the static
check is fooled.

---

## 7. Core-journey replay test

`scripts/verify-postgres-core-journey.ts`, in `verify:all`. It drives the
real service functions (not HTTP, except registration, which also proves the
route), runs `runTick` between steps until the outbox is drained, and then
asserts the outbox (by `correlationId` = the encounter) and every consumer's
effect.

**Journey and expected chain** (consumer-emitted events indented; `→` =
caused by):

| Step | Call | Events (in order) |
|---|---|---|
| 1 Register | `registerPatient` | `PatientRegistered` |
| 2 ED arrival | `registerEdArrival` | `EdArrivalRegistered` |
| 3 Triage | `recordTriage` (acuity 2) | `PatientTriaged` → `ChargePosted` (triage fee, if tariffed) |
| 4 Admission request | `createAdmissionRequest` | `AdmissionRequested` → `TaskCreated` (bed management) |
| 5 Bed | `allocateBed` | `BedReserved` → `TaskCompleted` (bed task) |
| 6 Admit | `admitPatient` | `AdmissionCreated` |
| 7 ICU | `transferWithinIcu` (ward bed → ICU bed) | `PatientTransferred`, `IcuAdmitted` → `ChargePosted` (ICU fee) |
| 8 Labs | `placeLabOrder` … `verifyResult` (critical) | `LabOrderPlaced`, `ChargePosted` (in-tx), `SpecimenCollected`, `LabResultReleased` → `TaskCreated` (critical result) + notification |
| 9 OT | `requestSurgery`, `scheduleSurgery`, `startProcedure`, `recordItemUsage`, `completeProcedure` | `SurgeryRequested`, `SurgeryScheduled`, `ProcedureStarted`, `SurgeryItemUsed` → `ChargePosted` (consumable) + stock movement, `ProcedureCompleted` → `ChargePosted` (procedure) |
| 10 Step-down | `transferPatient` (ICU → ward) | `PatientTransferred` |
| 11 Discharge | `initiateDischarge`, readiness, `finalizeDischarge` | `DischargeInitiated` → `TaskCreated` (discharge prep), `PatientDischarged`, `ChargePosted` (bed-days, in-tx), `EncounterClosed` |
| 12 Invoice | `draftInvoiceForAccount`, `issueInvoice` | `HospitalInvoiceIssued` → `ClaimDrafted` (patient has coverage) |
| 13 Claim draft | (by the consumer) | `ClaimDrafted` (not submitted: submission stays a human action) |

**Assertions**

- The outbox for the correlation holds exactly this sequence of types (the
  order of independent consumer outputs is compared as a set per step).
- Every event's payload passes its contract and `assertNoSensitiveData`.
- Every delivery for every consumer is PROCESSED; zero dead letters.
- **Replay:** reset every delivery for the correlation to PENDING
  (`replay.ts`) and run the runner again → no new rows anywhere (charges,
  tasks, stock entries, claims, notifications are unchanged in count).
- Invoice total = sum of the expected charges, each source charged once.
- The claim draft references that invoice and is not submitted.
- Tenancy: a parallel journey in another facility produces no rows visible
  to the first, and its events never reach the first facility's consumers'
  writes.

---

## 8. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Double effects on redelivery** (charges, stock, tasks) | unique natural keys on every consumer write; the per-consumer redelivery gate; the replay assertion in §7 |
| 2 | **Eventual consistency surprises** (a surgery charge appears seconds after completion; an invoice issued in that window misses it) | invoice drafting waits for the encounter's outbox to drain (a guard: no PENDING/RETRY/PROCESSING events with that correlationId), or shows "charges pending"; bed-days and orders stay in-tx |
| 3 | **Dispatcher not running** on staging (cron misconfigured) | `getEventMetrics` health already tracks the oldest pending age; alert at WARN/CRIT; the cron route logs a heartbeat |
| 4 | **Consumer silently unregistered** (the side-effect import trap) | `runTick` registers every consumer itself; a test asserts the registry contents at startup |
| 5 | **Head-of-line blocking** from per-aggregate ordering | blocks only that aggregate; dead letters stop blocking; the stale-claim reaper |
| 6 | **Sensitive data in payloads** as events multiply | strict contracts + `assertNoSensitiveData` at emit; payload review is part of each event's PR |
| 7 | **Task merge (D6)** breaks the workflow engine | same ids preserved; engine functions keep signatures; `verify-postgres-d7-workflows` must pass before `WorkflowTask` is dropped |
| 8 | **MAR sweep marks a dose missed that was given but not yet recorded** | grace period; the late recording is a new linked row; the missed event says `missedBy: SWEEP` so alerts read as "not recorded", not "not given" |
| 9 | **Route handlers emitting** (registration, encounters, orders) escape the CI rule | move them into services first (phase B step 1); the route allowlist in §6 must reach zero |
| 10 | **Outbox growth** | retention: archive PROCESSED events older than 90 days (phase C), keep dead letters until resolved |
| 11 | **Cron overlap** on Vercel | `SKIP LOCKED` + idempotent consumers make overlap harmless |
| 12 | **The 36 planned events differ from the plan's table** | §1.2 is derived from code; reconcile in review before phase B |

---

## 9. Order of wiring

Each step is its own commit with its gate; verify:all stays green after each.

1. **Runner skeleton:** `runTick`, `npm run worker`, `/api/cron/tick`,
   `SKIP LOCKED` claim with per-aggregate ordering, stale-claim reaper;
   consumer registration inside `runTick`. Fix `runAction`'s missing `tx`.
   Wire `PaymentFailed`.
2. **CI rule (§6)** with the current exemptions and route allowlist, so every
   later step is held to it.
3. **Services out of routes:** `registerPatient`, `openEncounter`,
   `placeLabOrder`, `placeImagingOrder`; move their emits.
4. **ADT events** (19–30) and the `task-generator` consumer for admission and
   discharge.
5. **D6 Task merge** (§4); `TaskCreated`/`TaskCompleted`.
6. **Orders, results, medication events** (31–38); `mar-scheduler` and the
   MAR sweep; `notification-dispatch` for critical results and missed doses.
7. **OT and blood events** (39–46) with the `charge-capture` and
   `stock-movement` consumers (new charges only; §5.2).
8. **Billing events** (50–54); `discharge-readiness` and `claim-drafting`
   consumers.
9. **`abdm-care-context`** consumer (behind the ABDM environment switch).
10. **Core-journey replay test (§7)** in `verify:all`; then retention.

The replay test is written early as a skeleton (step 1) and grows a step at a
time, so each wiring step lengthens the asserted chain.
