# Workflow spine: design (Week 3, phase A)

- **Status:** Approved 2026-10-15 with changes (scheduling, ordering, ten more
  events, the reserved rag-indexer). Phase B is being implemented.
- **Date:** 2026-10-15
- **Builds on:** ADR 0004 (modules sync through transactional domain events),
  `src/lib/events` (outbox, delivery ledger, catalogue, dispatcher) and
  `src/lib/workflows` (engine, timers, workflow tasks).

> **Source of the planned events.** The brief asks for "the 36 planned events
> (see the plan's Section 4 table)". That table is not in the repository or in
> this working session; the only catalogue in the repo is the illustrative one
> in `docs/EVENT_ARCHITECTURE.md` §4. The first 36 planned events in §1.2 were
> therefore **derived from the code**: one event per state change on the core
> journey and its billing tail, each tied to the existing service function that
> makes the change. Please reconcile §1.2 against the plan's table during
> review. Names, splits or merges can change without affecting the rest of the
> design. Ten more (#55–#64) were added at design review.

## Contents

1. Event catalogue (18 existing + 46 planned)
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
| 49 | `ClinicalNoteSigned` | CLINICAL_NOTE | `src/lib/hospital/clinicalNote.ts` → `signNote` and `amendNote` | sign tx / amend tx | noteId, encounterId, patientId, noteType, supersedesNoteId? (set on an amendment) | INTERNAL |

**Hospital billing and claims (5)**

| # | Event | Aggregate | Producer (file → function) | Transaction | Payload | Sens. |
|---|---|---|---|---|---|---|
| 50 | `ChargePosted` | CHARGE | `src/lib/hospital/billing/chargeCapture.ts` → `createCharge` (every path, including `createChargeIfNotExists` when it inserts) | the caller's tx | chargeId, encounterId, patientId, sourceType?, sourceId?, netAmountMinor, currency | LOW |
| 51 | `HospitalInvoiceIssued` | HOSPITAL_INVOICE | `src/lib/hospital/billing/invoices.ts` → `issueInvoice` | issue tx | invoiceId, encounterId?, patientId, totalMinor, currency | LOW |
| 52 | `HospitalPaymentRecorded` | HOSPITAL_PAYMENT | `src/lib/hospital/billing/payments.ts` → `recordPayment` | the idempotent insert tx | paymentId, billingAccountId, patientId, amountMinor, currency | LOW |
| 53 | `ClaimDrafted` | CLAIM | `src/lib/hospital/billing/claims.ts` → `createClaimDraft` | draft tx | claimId, invoiceId, coverageId, patientId | LOW |
| 54 | `ClaimSubmitted` | CLAIM | `src/lib/hospital/nhcx/submission.ts` → `dispatchSubmission` | the exchange create tx | claimId, submissionId, exchangeId, version | LOW |

**Added at design review (10)**

| # | Event | Aggregate | Producer (file → function) | Transaction | Payload | Sens. |
|---|---|---|---|---|---|---|
| 55 | `PatientDocumentUploaded` | CLINICAL_DOCUMENT | `src/lib/patient/experience/documents.ts` → `uploadPatientDocument` (replaces its Week 2 TODO) | the ClinicalDocument insert (the file is stored before the tx; a rolled-back insert leaves an orphan object that the storage sweep removes) | documentId, patientId, documentType, uploadedBy: PATIENT | INTERNAL |
| 56 | `DocumentGenerated` | CLINICAL_DOCUMENT | `src/lib/documents/service.ts` → `generateAndStoreDocument` | the GeneratedDocument + ClinicalDocument tx (D4) | documentId, generatedDocumentId, patientId, documentType, isDraft | INTERNAL |
| 57 | `CriticalResultAcknowledged` | LAB_RESULT / IMAGING_REPORT | `src/lib/hospital/labResultLifecycle.ts` → `acknowledgeResult` and `src/lib/hospital/imagingReportLifecycle.ts` → `acknowledgeReport` (only when the result/report is critical) | the acknowledge tx | resultId? / reportId?, patientId, acknowledgedByStaffId, minutesToAcknowledge | INTERNAL |
| 58 | `PreauthDecided` | PREAUTH | `src/lib/hospital/billing/preauth.ts` → `decidePreAuth` | the decision tx | preAuthId, coverageId, patientId, decision (APPROVED \| DENIED), approvedAmountMinor?, currency | LOW |
| 59 | `ClaimSettled` | CLAIM | `src/lib/hospital/billing/claims.ts` → `settleClaim` | the settlement tx | claimId, invoiceId, settledAmountMinor, currency | LOW |
| 60 | `FamilyAccessGranted` | PATIENT_DELEGATION | `src/lib/patient/experience/family.ts` → `acceptDelegation` (access starts on acceptance, not on invitation) | the accept tx | delegationId, patientId, delegateUserId, scopes (closed codes) | SENSITIVE |
| 61 | `FamilyAccessRevoked` | PATIENT_DELEGATION | `src/lib/patient/experience/family.ts` → `revokeDelegation` (and expiry, when the sweep in §3.4 expires a delegation) | the revoke tx | delegationId, patientId, delegateUserId, reason: REVOKED \| EXPIRED | SENSITIVE |
| 62 | `EdDispositionDecided` | ENCOUNTER | `src/lib/hospital/emergency.ts` → `dispositionEncounter` | the disposition tx | dispositionId, encounterId, patientId, dispositionType | INTERNAL |
| 63 | `StockBelowReorder` | ITEM | `src/lib/hospital/inventory/ledger.ts` → `postLedgerEntry` (only when this entry takes the location balance from at-or-above to below the item's `reorderPoint`) | the ledger tx | itemId, locationId, onHandQty, reorderPoint | LOW |
| 64 | `GoodsReceived` | GOODS_RECEIPT | `src/lib/hospital/procurement/goodsReceipts.ts` → `approveGoodsReceipt` (stock is posted on approval) | the approve tx | goodsReceiptId, purchaseOrderId, supplierId, lineCount | LOW |

**Deliberately not events**

- **`QueueTokenCalled`.** Calling the next token is high-frequency,
  short-lived operational state (seconds to minutes) with no cross-module
  reaction: nothing is billed, scheduled or recorded on the clinical record
  because of it. The queue screens read `QueueEntry` directly. An event per
  call would grow the outbox with rows no consumer reads. If a display board
  or analytics ever needs it, it reads the queue table or a projection.
- **`DischargeBarrierCleared`.** Discharge barriers aren't stored state: the
  barrier engine (`src/lib/hospital/dischargeBarrierEngine.ts`) computes them
  from current facts (pending results, unpaid balance, missing summary) on
  every read. There is no transition to emit, and the facts that clear a
  barrier already have their own events (`LabResultReleased`,
  `HospitalPaymentRecorded`, `DocumentGenerated`, `TaskCompleted`), which the
  `discharge-readiness` consumer listens to.

All planned events are `FACILITY` scope. `MedicationDoseMissed`,
`TransfusionReactionReported`, `FamilyAccessGranted` and `FamilyAccessRevoked`
are `SENSITIVE` because the fact itself is sensitive; operator views (`ops.ts`)
show their type and IDs only.

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
| `workflow-engine` (exists) | `*` | `WorkflowInstance`, steps, timers, tasks | `WorkflowInstance.idempotencyKey` derived from (definition, eventId) | retry; dead letter on an invalid definition | **yes** (per aggregate, like every ordered consumer; it re-reads current state) |
| `charge-capture` | `ProcedureCompleted`, `SurgeryItemUsed`, `BloodIssued`, `PatientTriaged` (ED triage fee where tariffed), `EncounterOpened` (consultation fee where tariffed), `IcuAdmitted` (ICU admission fee) | `Charge` via `createPricedChargeIfNotExists` | `Charge (sourceType, sourceId)` unique: e.g. (`Surgery`, surgeryId), (`SurgeryItemUsage`, usageId), (`BloodIssue`, issueId) | `PriceNotFoundError` → posts the zero-priced "needs pricing" charge exactly as the in-tx paths do today (never blocks, never silently skips); DB errors retry; a charge on an invoiced encounter → dead letter + reconciliation exception | no (each charge is keyed by its own source) |
| `stock-movement` | `SurgeryItemUsed`, `MedicationDispensed` (only for the paths migrated per §5.3) | `StockLedgerEntry` via `inventory/issue` | ledger `(sourceType, sourceId)` unique (already used by `postLedgerEntry`) | insufficient stock → dead letter + an inventory exception task (the clinical act already happened; we never roll it back) | no |
| `task-generator` | `AdmissionRequested`, `BedReserved`, `DischargeInitiated`, `LabResultReleased` (critical only), `ImagingReportReleased` (critical only), `CriticalResultAcknowledged` (closes the critical-result task), `MedicationDoseMissed`, `TransfusionReactionReported`, `EdDispositionDecided` (admit → admission-request task), `PatientDocumentUploaded` (review task for the care team), `StockBelowReorder` (requisition task) | `Task` (source `EVENT`) | `Task.idempotencyKey = <consumer>:<eventId>:<taskType>` (unique, new column; §4) | retry; dead letter if the patient/encounter is not visible in the tenant | no |
| `notification-dispatch` | critical `LabResultReleased` / `ImagingReportReleased`, `TransfusionReactionReported`, `MedicationDoseMissed`, `TaskCreated` (STAT only) | `Notification` | `Notification (sourceEventId, recipientUserId)` unique (new) | retry; recipient no longer active → processed with no notification | no |
| `discharge-readiness` | `LabResultReleased`, `ImagingReportReleased`, `MedicationDispensed`, `DocumentGenerated` (discharge summary), `HospitalInvoiceIssued`, `HospitalPaymentRecorded`, `ClaimDrafted`, `PreauthDecided`, `ClaimSettled`, `TaskCompleted` | `Discharge` readiness flags via `updateDischargeReadiness` | absolute recompute (the flags are a pure function of current state, so redelivery converges) | retry | **yes** (per admission: a late-arriving older event must not overwrite a newer recompute; recompute reads current state, so ordering only matters for the audit trail) |
| `claim-drafting` | `HospitalInvoiceIssued` (encounter with ACTIVE coverage) | `Claim` draft via `createClaimDraft` | `Claim (invoiceId)` unique for non-void claims (existing guard, made a partial unique index) | no coverage → processed, nothing written; preauth missing → draft with a blocker (never submitted automatically) | no |
| `abdm-care-context` | `PatientDischarged`, `LabResultReleased`, `ImagingReportReleased` (patients with a linked ABHA and a live consent) | `HealthInformationExchange` (OUTBOUND, REQUESTED) via `requestExchange` | HIE `(facilityId, idempotencyKey)` with key = `care-context:<eventId>` | consent revoked → processed, nothing sent (re-checked through `@/lib/consent`); ABDM down → retry | **yes** (per patient) |
| `mar-scheduler` | `MedicationVerified` | `MedicationAdministration` schedule rows (status SCHEDULED) | `(medicationOrderId, scheduledAt)` unique (new) | retry; order no longer active when it runs → processed, nothing scheduled | **yes** (per order) |

**Reserved for Week 4 (design only, not built in Week 3)**

| Consumer | Subscribes to | Writes | Idempotency key | Failure / retry / dead letter | Ordered per aggregate |
|---|---|---|---|---|---|
| `rag-indexer` | `ClinicalNoteSigned`, `LabResultReleased`, `ImagingReportReleased`, `PatientDocumentUploaded`, `DocumentGenerated`, `PatientDischarged`, `ConsentRevoked`, `FamilyAccessRevoked` | the patient's retrieval index (chunks + embeddings, pgvector) and its access list | chunk key = (sourceType, sourceId, chunkNo); one index row per source, replaced in place | retry (embedding provider down); dead letter on a source the tenant can't read | **yes** (per aggregate: an amendment must not be overtaken by its predecessor) |

- **Amendments replace.** `ClinicalNoteSigned` with `supersedesNoteId`, an
  amended lab result or report: the consumer deletes the superseded source's
  chunks and indexes the new one in one transaction, so retrieval never sees
  both versions.
- **Revocations remove access.** `ConsentRevoked` removes the consent's
  recipients from the access list of every chunk it covered;
  `FamilyAccessRevoked` removes the delegate. Retrieval filters by the access
  list at query time as well, so a revocation is effective even before the
  consumer runs; the consumer makes it durable and auditable.
- **IDs only in events.** The consumer re-reads the source through its owning
  service (with tenancy checks) to get the text; events never carry it.

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

**Staging/production:** `POST /api/cron/tick`, **trigger-agnostic**: it runs
one bounded tick for whoever calls it with the secret. Authenticated by
`CRON_SECRET` in the `Authorization: Bearer` header (constant-time compare),
not by a user session; refused when `CRON_SECRET` is unset. `budgetMs: 50_000`
keeps it inside the function limit. The existing platform-operator routes
(`enterprise/events/dispatch`, `enterprise/workflow-ops/tick`) stay as manual
triggers.

- **Staging trigger:** Vercel Hobby allows only a daily cron, so staging uses
  **Supabase `pg_cron` + `pg_net`**: a `cron.schedule` job, every minute,
  `net.http_post`s to `/api/cron/tick` with the secret. This is ops
  configuration, documented step by step in `docs/STAGING_SUPABASE.md`, not a
  Prisma migration. It is **the one documented exception** to "extensions are
  enabled by migrations": `pg_cron` and `pg_net` are staging infrastructure
  that drives the app from outside, not part of the app's schema, and the app
  must work without them (local runs use `npm run worker`).
- **Production option later:** Vercel Pro cron (every minute) calling the same
  route. Nothing in the app changes.

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
concurrent worker reads the same candidate list and loses most claims, and it
orders by `occurredAt`, which can't order events reliably. `occurredAt` is
domain time from the application clock (`emitDomainEvent` uses the caller's
timestamp or `new Date()`): events from one transaction can tie (same
millisecond, or a service passing one `now` to several emits), and clocks on
different instances aren't ordered at all.

**Order key.** `DomainEventOutbox` gains `seq BIGINT GENERATED ALWAYS AS
IDENTITY`: monotonic in insert order, so two events emitted in one transaction
keep the order they were emitted in. Claims order by `seq`, never by
`occurredAt`. (Implemented in phase B step 1:
`20261015160000_outbox_seq`, `src/lib/events/dispatcher.ts`.) The ordering lookup is indexed:
`CREATE INDEX … ON "DomainEventOutbox" ("aggregateType", "aggregateId", seq)
WHERE status IN ('PENDING', 'RETRY', 'PROCESSING')` (partial, so finished
events don't grow it).

**One ordering key: the aggregate.** Ordering is enforced in the claim, per
(aggregateType, aggregateId), and nowhere else. No consumer orders by
`correlationId` or any other key; the consumers marked *ordered* in §2
(including `workflow-engine`) re-read current state when they run, so
per-aggregate order is all they need.

Phase B switches the claim to one statement:

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
        AND e.seq < "DomainEventOutbox".seq
        AND e.status IN ('PENDING', 'RETRY', 'PROCESSING'))
  ORDER BY seq
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
- **Delegation expiry:** the same sweep expires family delegations past
  `expiresAt` (guarded update) and emits `FamilyAccessRevoked` with
  `reason: EXPIRED`.
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

**As built (step 5, 2026-10-15).** Two migrations: `20261015180000_task_merge`
(refusals, then the merge; WorkflowTask kept) and
`20261015190000_drop_workflow_task` (refuses unless every WorkflowTask row is
reachable as a Task with the same id and instance, then drops it).
`verify-postgres-d7-workflows` (48/0), `-d8-configuration` (40/0) and
`-d9-builder` (31/0) were run against the database with only the first
migration applied, then D7 again after the drop. Deviations from the table
above:

- **`facilityId` is not required.** The engine creates tasks for
  organization-scoped events (`PaymentReceived`, `InvoiceFinalized` carry no
  facility), and the D7 gate depends on that. `Task.facilityId` is nullable
  only for `source = WORKFLOW` with an `organizationId`
  (`Task_facility_or_org_workflow_check`); workflow links appear exactly on
  workflow tasks (`Task_workflow_links_check`).
- **Workflow keys stay global**, by a partial unique index
  (`WHERE source = 'WORKFLOW'`); every other key is unique per facility.
- **Free-text sources** found in the code: `manual`, `care-plan`, `lab-order`,
  `imaging-order` (→ ORDER) and `event`. A NULL source maps only through the
  row's own order or care-plan intervention link.
- **Patients and encounters on workflow tasks are checked.** `Task.patientId`
  is a foreign key, so `createWorkflowTask` refuses (as a VALIDATION failure) a
  patient or encounter that is not in the task's facility. The D7/D9 gates used
  made-up ids (`"p1"`, `"e1"`) in their event payloads; they now create a real
  patient and encounter per gate facility. No assertion changed.
- `TaskCreated` / `TaskCompleted` are ORGANIZATION-scoped (the facility is
  carried when there is one), correlated by the encounter. `createTask` and
  `closeTask` in `src/lib/hospital/task.ts` are the only writers; the manual
  task route now goes through `createTask`.

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

**As implemented (phase B step 2).** `src/lib/events/emitCoverage.ts` (the
analysis), `emitCoverage.test.ts` (the rule, plus fixtures proving each check
fails when it should) and `emitExemptions.ts`. Differences from the plan
above, decided while building it:

- A helper "one level deep" is resolved across all of `src/lib`, not only the
  same file (e.g. `markAttempt` emits through `emitPaymentFailed`).
- **A ratchet, not a wish list.** The baseline was generated from the code:
  450 exported functions wrote without emitting. Each is listed with a
  category. The test fails on any *new* unlisted writer and on any *stale*
  entry (a listed function that now emits or no longer writes), so the list
  only changes deliberately and shrinks as steps land.
- **Categories:** `PLANNED` (48, names the event and its §9 step; removed in
  the commit that wires it), `BOOKKEEPING` (53), `REFERENCE_DATA` (32),
  `CONFIGURATION` (40), and **`NOT_YET_CATALOGUED` (277)**: real domain
  changes (blood unit quarantine, ICU device updates, quality incidents, …)
  that no consumer needs today. That category is new: listing them makes
  "should this be an event?" a visible product decision instead of an
  accident, without inventing 277 events nobody consumes.
- The route allowlist started at 36 handlers.
- **Batch 3a (2026-10-16): `NOT_YET_CATALOGUED` is gone.** The approved triage
  (`docs/EVENT_TRIAGE.md`) turned its 272 entries into 186 `PLANNED` producers
  (steps 4–9c) and 86 named exemptions in four new categories:
  `PROCESS_STEP` (each names its boundary event, which must be catalogued or
  owed), `OPERATIONAL_DETAIL`, `INTEGRATION_PROTOCOL` and `CONSUMER_OUTPUT`.
  The category is no longer accepted, and a test keeps its count at 0.
  `SENSITIVE_EVENTS` and `REQUIRED_PAYLOAD_FIELDS` hold the approved
  sensitivity and type-code conditions, checked as each contract lands.

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
| 8a Critical acknowledgement | `acknowledgeResult` | `CriticalResultAcknowledged` → `TaskCompleted` (the critical-result task closes) |
| 8b Outside report | `uploadPatientDocument` (patient portal, PDF) | `PatientDocumentUploaded` → `TaskCreated` (care-team review) |
| 9 OT | `requestSurgery`, `scheduleSurgery`, `startProcedure`, `recordItemUsage`, `completeProcedure` | `SurgeryRequested`, `SurgeryScheduled`, `ProcedureStarted`, `SurgeryItemUsed` → `ChargePosted` (consumable) + stock movement, `ProcedureCompleted` → `ChargePosted` (procedure) |
| 10 Step-down | `transferPatient` (ICU → ward) | `PatientTransferred` |
| 11 Discharge | `initiateDischarge`, discharge summary, readiness, `finalizeDischarge` | `DischargeInitiated` → `TaskCreated` (discharge prep), `DocumentGenerated` (discharge summary), `PatientDischarged`, `ChargePosted` (bed-days, in-tx), `EncounterClosed` |
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
- The critical-result task created in step 8 is COMPLETED by step 8a, and
  `minutesToAcknowledge` in the event matches the stored timestamps.
- The uploaded document from step 8b appears in the Hospital OS document list
  and has exactly one review task.
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
| 12 | **The planned events differ from the plan's table** | §1.2 #19–#54 are derived from code; reconcile before the step that wires them |
| 13 | **`pg_cron` job missing or pointed at the wrong URL** on staging | `docs/STAGING_SUPABASE.md` includes a check query (`cron.job_run_details`) and the oldest-pending-age health alert catches a stopped trigger |

---

## 9. Order of wiring

Each step is its own commit with its gate; verify:all stays green after each.

1. **Runner skeleton:** `runTick`, `npm run worker`, trigger-agnostic
   `/api/cron/tick`, the outbox `seq` column and its partial index, the
   `SKIP LOCKED` claim with per-aggregate ordering by `seq`, the stale-claim
   reaper; consumer registration inside `runTick`. Fix `runAction`'s missing
   `tx`. Wire `PaymentFailed`. `docs/STAGING_SUPABASE.md` gets the `pg_cron` +
   `pg_net` trigger.
2. **CI rule (§6)** with the current exemptions and route allowlist, so every
   later step is held to it.
3. **Services out of routes:** `registerPatient`, `openEncounter`,
   `placeLabOrder`, `placeImagingOrder`; move their emits.
4. **ADT events** (19–30) plus `EdDispositionDecided` (62), and the
   `task-generator` consumer for admission, disposition and discharge.
5. **D6 Task merge** (§4); `TaskCreated`/`TaskCompleted`.
6. **Orders, results, medication events** (31–38) plus
   `CriticalResultAcknowledged` (57); `mar-scheduler` and the MAR sweep;
   `notification-dispatch` for critical results and missed doses.
7. **Documents and family access:** `PatientDocumentUploaded` (55),
   `DocumentGenerated` (56), `ClinicalNoteSigned` with `supersedesNoteId` (49),
   `FamilyAccessGranted`/`Revoked` (60–61) and delegation expiry in the sweep.
8. **OT and blood events** (39–46) with the `charge-capture` and
   `stock-movement` consumers (new charges only; §5.2).
9. **Billing events** (50–54) plus `PreauthDecided` (58) and `ClaimSettled`
   (59); `discharge-readiness` and `claim-drafting` consumers.
10. **Core-journey replay test (§7)** complete in `verify:all`; retention.

**Cut list** (built if Week 3 has room; nothing earlier depends on them):

- `StockBelowReorder` (63) and `GoodsReceived` (64), with the requisition
  task in `task-generator`.
- The `abdm-care-context` consumer (behind the ABDM environment switch).

The `rag-indexer` (§2) is Week 4.

**As built: step 5b and step 6 (2026-10-16).** Gates
`verify-postgres-nursing-events` (16), `verify-postgres-orders-results-medication`
(45) and the first `verify-postgres-core-journey` (20: steps 1–8a of §7 plus a
medication round, with the replay and tenancy assertions; it did not exist
before step 6, so step 6 created it). Departures from the text above:

- **MAR vocabulary.** Scheduled doses are `DUE` (the existing
  `MedicationAdministrationStatus`), not `SCHEDULED`. `(medicationOrderId,
  scheduledAt)` is unique by a partial index (rows that are not late
  recordings), migration `20261016100000_mar_schedule_and_notification_keys`,
  which refuses duplicates rather than merging them.
- **Dose times come from the event.** mar-scheduler computes the schedule from
  `MedicationVerified.occurredAt`, so a redelivery inserts nothing; it checks
  the order's status under a row lock, so a concurrent stop either cancels the
  new doses or prevents them. `createMedicationOrder` no longer schedules doses.
- **Grace key.** `mar.missed_grace` (a duration in seconds, default 3600),
  following the registry's snake_case/duration convention, not
  `mar.missedGraceMinutes`.
- **What the sweep skips.** PRN orders, and orders that are held, stopped or
  completed: only orders being given (VERIFIED, DISPENSED, ACTIVE) can miss a
  dose. Stopping a drug cancels its future DUE doses in the same transaction.
- **Late recording** of a swept dose is a new row with
  `lateForAdministrationId` (unique), emitting `MedicationAdministered` with that
  link; the MISSED row is never rewritten.
- **Two aggregates for one event.** `CriticalResultAcknowledged` and
  `DiagnosticReportAmended` are about a LAB_RESULT or an IMAGING_REPORT; a
  contract may now list `alternateAggregateTypes`, chosen per emit, so each is
  ordered behind its own release. An amendment is emitted on the original's
  aggregate.
- **notification-dispatch** writes `Notification` rows for staff profiles
  (the model's recipient), unique on `(sourceEventId, recipientStaffId)`.
  Recipients: the ordering clinician; for a missed dose also the patient's
  assigned nurse. Inactive staff are skipped.
- **Payload details.** `ImagingOrderPlaced.modality` is a closed code (the
  column has a CHECK); `MedicationDispensed.quantity` is a positive number (the
  column is a float); `NursingAssessmentRecorded` has no `assessmentType` (the
  model has no type column).
- **Release events are correlated by the encounter** (`LabResultReleased`,
  `ImagingReportReleased`, `MedicationOrdered` had their own correlation), and an
  imaging report with no linked study is now released with an event (it emitted
  nothing before).

**Batch 4, decision 1 (critical-result tasks).** The task-generator owns the
critical-result task. The seeded `critical-lab-review` workflow (and its
builder template) is escalate-only: a new `ESCALATE` step type schedules an SLA
timer against the existing task, found by its idempotency key
(`CRITICAL_RESULT_FOLLOW_UP:<resultId>`); on breach, if the task is still open,
the task service's `escalateTask` raises its priority and reassigns it to
HOSPITAL_ADMIN (`TaskUpdated` v2, `escalated: true`). It never creates a task.
The SLA still resolves through `workflow.critical-lab-review.sla`. The seed
publishes a new version where an older one is live, and migration
`20261016200000_workflow_escalate_step` widens the step-type CHECK.

**Batch 4, decision 2.** `MedicationDoseNotGiven` (SENSITIVE), distinct from
`MedicationDoseMissed`: a nurse recorded the dose REFUSED or HELD.
`reasonCode` is closed (REFUSED, HELD, PATIENT_ABSENT, NPO, OTHER), mapped from
the MAR's free-text code by `doseNotGivenReason`, never copied. A CANCELLED dose
emits nothing.

**Batch 4, decision 3 (emit rule).** The rule follows private helpers in the
same file at any depth, for writes and for emits; registered helpers across
files as before. It found 17 writers (EVENT_TRIAGE.md, round 3): three wired
here (`checkInStudy`, `startStudy`, `receiveSpecimen`, through the v2 contracts
of `ImagingStudyStatusChanged` and `SpecimenStatusChanged`), thirteen planned,
one bookkeeping. The fixture that showed an unregistered helper counts one
level only now uses exported helpers (a private chain is followed by design),
and new fixtures prove private chains are followed for writes and emits.

**Batch 4, decision 5 (bounded failure).** Event consumers: a Prisma
data-integrity error (P2003, P2014, P2018, P2025: a missing parent or record)
gets `DATA_ERROR_ATTEMPTS` (3) instead of the event's 8, then dead-letters with
code `DATA_<code>`; tenant mismatches were already permanent. Workflows: such
errors are NOT_FOUND (terminal); a timer that fails is FAILED (new
`WorkflowTimerStatus` value) at once when permanent or after
`MAX_TIMER_ATTEMPTS` (5), released with backoff in between (it used to be
released to PENDING forever); a failure outside the step loop is bounded by
`MAX_INSTANCE_ATTEMPTS` (5) instead of leaving the instance RUNNING; a RUNNING
instance whose claim is older than 5 minutes is reaped. Failed instances and
timers are listed by `listWorkflowDeadLetters`, returned with the event dead
letters by `/api/hospital/enterprise/events/dead-letters`. The tenancy-sweep
fixtures of the queue tables are created finished, so they never enter the
queues. Gate: `verify-postgres-bounded-retry`.

**As built: step 8 (batch 4).** OT and blood events (#39–46) and the triage's
step-8 events; consumers `charge-capture` and `stock-movement`. Gate
`verify-postgres-ot-blood-events`; the core journey gains step 9. Departures:

- **Surgical stock moves in the consumer.** `recordItemUsage` no longer calls
  `issueStock`; it emits `SurgeryItemUsed` with the issuing location and
  `stock-movement` issues it (ledger keyed by the usage, so redelivery is a
  no-op). A shortfall leaves the usage recorded, dead-letters with
  STOCK_UNAVAILABLE and opens one INVENTORY_EXCEPTION task: the §2 row, and
  ADR 0004's example of a direct call to remove. Before, a shortfall rolled the
  usage back. `MedicationDispensed` is not consumed (no dispensing path moved).
- **Pricing.** Specific tariff, then generic (`PROCEDURE:<code>` /
  `PROCEDURE:GENERIC`, `ITEM:<sku>` / `OT_<type>:GENERIC`, `BLOOD:<code>` /
  `BLOOD:GENERIC`, `ICU:ADMISSION`); with none, a zero-priced charge whose
  description says "needs pricing". Consultation (`CONSULT_OPD`, OPD
  encounters) and ED triage (`ED:TRIAGE`) only where tariffed.
- **Invoiced encounter.** The charge dead-letters with ENCOUNTER_INVOICED
  (visible in the dead-letter list). No reconciliation-exception row: the
  existing exception model is the commercial one; a hospital-billing one is
  step 9's.
- **Blood unit transitions** compare-and-set on the exact status read, and the
  "ignore if it already moved" calls ignore only that conflict (they swallowed
  every error). `verifyCompatibility` is now compare-and-set.

**Batch 5, decision 1 (needs-pricing charges).** `Charge.pricingStatus`
(PRICED, NEEDS_PRICING, WAIVED; migration `20261017100000`, which refuses a
"(needs pricing)" charge that already carries an amount, with CHECKs that a
NEEDS_PRICING charge is 0 and a WAIVED one has a reason). charge-capture posts
NEEDS_PRICING when no tariff exists; `issueInvoice` refuses while any line needs
pricing; billing resolves it with `priceCharge` (tariff code or amount;
`ChargeRepriced`) or `waiveCharge` (reason code; `ChargeWaived`), both audited,
through `POST …/charges/[chargeId]/pricing` (billing:adjustment:approve).
Seeded tariffs: PROCEDURE:GENERIC, BLOOD:GENERIC, ICU:ADMISSION and ITEM:<sku>
for the seeded consumables, surgical supplies and implants (no procedures or
blood products are seeded, so those have generic codes only).

**Triage sub-steps** (`docs/EVENT_TRIAGE.md`, approved 2026-10-16): 5b
(nursing and tasks), then, after step 9, 9a (inventory and procurement), 9b
(quality, safety, operations) and 9c (access, identity, interoperability,
workforce). Step 9a also changes the **waste flow**: `recordWaste` moves the
quantity to a HOLD state (unavailable, not written off) with a ledger entry;
`approveWaste` posts the write-off from HOLD; `rejectWaste` posts a return
from HOLD to available stock. Ledger entries are never edited. Its gate
covers record → reject (stock fully restored) and record → approve (written
off exactly once). Today a rejected waste stays written off.

The replay test is written early as a skeleton (step 1) and grows a step at a
time, so each wiring step lengthens the asserted chain.
