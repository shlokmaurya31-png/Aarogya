# Event triage: the "not yet catalogued" writes

- **Date:** 2026-10-15 (Week 3, phase B batch 2)
- **Status:** for review. **Nothing here is wired yet.** Counts first, wiring after approval.
- **Scope:** every exported service function that the CI emit rule (`src/lib/events/emitCoverage.test.ts`) lists as `NOT_YET_CATALOGUED` in `src/lib/events/emitExemptions.ts`. That was 277 when the rule landed; step 3 turned two of them (self-registration) into emitters, so **275** remain.

## Rules applied

A function **becomes a planned event** if it:

- **(a)** changes a patient's care or record;
- **(b)** moves money or stock;
- **(c)** changes access or permissions; or
- **(d)** is a safety or quality fact (incident, quarantine, recall, calibration failure, equipment fault).

Otherwise it gets a **named exemption category** with a one-line reason. New categories:

| Category | Meaning |
|---|---|
| `PROCESS_STEP` | An intermediate step (draft, request, pending approval). The outcome that matters is its own event. |
| `OPERATIONAL_DETAIL` | Logistics or housekeeping with no effect on care, money, stock, access or safety. |
| `INTEGRATION_PROTOCOL` | Inbound callback/webhook logs and protocol state of external exchanges. The changes they cause emit their own events. |
| `CONSUMER_OUTPUT` | Written by an event consumer in reaction to another event (consumer writes don't emit). |

New events follow the same rules as §1 of `docs/WORKFLOW_SPINE_DESIGN.md`: emitted in the producer's transaction, IDs and closed codes only, no free text. They don't need consumers.

## Counts

| Decision | Functions |
|---|---|
| **Becomes a planned event** | **182** (155 distinct event names) |
| &nbsp;&nbsp;(a) care or record | 76 |
| &nbsp;&nbsp;(b) money or stock | 51 |
| &nbsp;&nbsp;(c) access or permissions | 16 |
| &nbsp;&nbsp;(d) safety or quality | 39 |
| **Named exemption** | **93** |
| &nbsp;&nbsp;`PROCESS_STEP` | 47 |
| &nbsp;&nbsp;`OPERATIONAL_DETAIL` | 35 |
| &nbsp;&nbsp;`INTEGRATION_PROTOCOL` | 7 |
| &nbsp;&nbsp;`CONSUMER_OUTPUT` | 2 |
| &nbsp;&nbsp;`BOOKKEEPING` | 1 |
| &nbsp;&nbsp;`REFERENCE_DATA` | 1 |
| **Total** | **275** |

Planned events by wiring step:

| Step | Module | Functions | Distinct events |
|---|---|---|---|
| 4 | ADT, scheduling and ED | 19 | 13 |
| 5 | Nursing and tasks | 8 | 7 |
| 6 | Orders, results, medication, pharmacy, ICU, care plans | 34 | 32 |
| 7 | Patient access, consent and record | 10 | 10 |
| 8 | Operating theatre and blood bank | 22 | 22 |
| 9 | Billing, claims and NHCX | 25 | 25 |
| 9a | Inventory and procurement | 23 | 11 |
| 9b | Quality, safety and operations | 27 | 25 |
| 9c | Access, identity, interoperability and workforce | 14 | 13 |

Steps 9a, 9b and 9c are new: those modules had no §9 step. They slot in after step 9 (billing) and before step 10 (the core-journey replay test).

## Design notes

- **One stock event.** Every stock movement goes through `postLedgerEntry` (`src/lib/hospital/inventory/ledger.ts`). It emits one `StockMoved` event (ledgerEntryId, itemId, lotId?, locationId, movementType, quantity, sourceType, sourceId) instead of a separate event per inventory function. 13 of the triaged functions are covered by it. Some reach the ledger two calls deep (through `issueStock`/`reserveStock`), so when 9a is wired the CI rule's "emits through a helper" resolution becomes transitive (it is one level deep today).
- **Shared events.** Several functions emit one event type where they record the same kind of fact: `ObservationRecorded` (ICU and transfusion observations, with an observation-kind code), `AdmissionRequestDecided` (cancel/defer/reject, with the decision), `TransferRequestStatusChanged`, `StaffAssignmentChanged`, `CarePlanUpdated`, `ImagingStudyScheduled` (schedule/reschedule), `StockLotQuarantined`/`StockLotReleased` (inventory and pharmacy lots).
- **Existing events reused:** `ReconciliationExceptionResolved` (a second producer), `ClaimSubmitted` (the non-NHCX path), `PatientTransferred` (`completeTransferRequest` is covered once `transferPatientInTx` emits in step 4).
- **Static-analysis limit.** `decideLinkRequest` counts as emitting because its CREATE_NEW branch calls `createRegisteredPatient`; its LINK branch links an account without an event. `PatientAccountLinked` (from `verifyLinkOtp`, step 7) should also be emitted on that branch.

## Borderline calls to review

These went to an exemption, but a reasonable reading of the rules could make them events:

- **Meal delivery** (`transitionMeal`): a REFUSED or MISSED meal is arguably a care fact (nutrition intake). Exempted as kitchen logistics; the diet order itself is an event.
- **Patient transport and ambulance trips:** exempted as logistics; the patient's location changes are their own events.
- **Staff shifts and availability:** exempted; bookability reads them directly and they don't change access.
- **Queue tokens:** exempted, consistent with the approved "QueueTokenCalled is not an event".
- **Theatre team roster** (`setTeamMember`): exempted as a roster; if team membership should gate access to the case record, it becomes (c).
- **Refund approval** and **adjustment requests**: exempted as process steps; money moves only on completion/approval respectively.

## New events by module

### Step 4: ADT, scheduling and ED (19 functions)

| Function | File | Decision | Proposed event | Step |
|---|---|---|---|---|
| `cancelRequest` | `src/lib/hospital/admissionRequest.ts` | event (a) | `AdmissionRequestDecided` | 4 |
| `deferRequest` | `src/lib/hospital/admissionRequest.ts` | event (a) | `AdmissionRequestDecided` | 4 |
| `rejectRequest` | `src/lib/hospital/admissionRequest.ts` | event (a) | `AdmissionRequestDecided` | 4 |
| `releaseReservation` | `src/lib/hospital/admissionRequest.ts` | event (a) | `BedReservationReleased` | 4 |
| `confirmAppointment` | `src/lib/hospital/appointment.ts` | event (a) | `AppointmentConfirmed` | 4 |
| `markNoShow` | `src/lib/hospital/appointment.ts` | event (a) | `AppointmentNoShow` | 4 |
| `activateResuscitation` | `src/lib/hospital/emergency.ts` | event (a) | `ResuscitationActivated` | 4 |
| `assignEdLocation` | `src/lib/hospital/emergency.ts` | event (a) — EncounterLocation is the location history (D5) | `PatientLocationChanged` | 4 |
| `recordReassessment` | `src/lib/hospital/emergency.ts` | event (a) | `EdReassessmentRecorded` | 4 |
| `releaseEdLocation` | `src/lib/hospital/emergency.ts` | event (a) | `PatientLocationChanged` | 4 |
| `updateResuscitation` | `src/lib/hospital/emergency.ts` | event (a) | `ResuscitationStatusChanged` | 4 |
| `acceptTransferRequest` | `src/lib/hospital/transferRequest.ts` | event (a) | `TransferRequestStatusChanged` | 4 |
| `cancelTransferRequest` | `src/lib/hospital/transferRequest.ts` | event (a) | `TransferRequestStatusChanged` | 4 |
| `completeTransferRequest` | `src/lib/hospital/transferRequest.ts` | event (a) — covered once transferPatientInTx emits | `PatientTransferred (via transferPatientInTx)` | 4 |
| `createTransferRequest` | `src/lib/hospital/transferRequest.ts` | event (a) | `TransferRequested` | 4 |
| `markPatientInTransit` | `src/lib/hospital/transferRequest.ts` | event (a) | `TransferRequestStatusChanged` | 4 |
| `reserveBedForTransfer` | `src/lib/hospital/transferRequest.ts` | event (a) | `TransferRequestStatusChanged` | 4 |
| `mergePatients` | `src/lib/patient/merge.ts` | event (a) | `PatientsMerged` | 4 |
| `unmergePatients` | `src/lib/patient/merge.ts` | event (a) | `PatientsUnmerged` | 4 |

### Step 5: Nursing and tasks (8 functions)

| Function | File | Decision | Proposed event | Step |
|---|---|---|---|---|
| `acknowledgeHandoff` | `src/lib/hospital/handoff.ts` | event (a) | `ClinicalHandoffAcknowledged` | 5 |
| `createHandoff` | `src/lib/hospital/handoff.ts` | event (a) — transfers responsibility for the patient | `ClinicalHandoffCreated` | 5 |
| `amendAssessment` | `src/lib/hospital/nursingAssessment.ts` | event (a) — amendment carries supersedesAssessmentId, like notes | `NursingAssessmentSigned` | 5 |
| `completeAssessment` | `src/lib/hospital/nursingAssessment.ts` | event (a) | `NursingAssessmentCompleted` | 5 |
| `signAssessment` | `src/lib/hospital/nursingAssessment.ts` | event (a) | `NursingAssessmentSigned` | 5 |
| `assignNurse` | `src/lib/hospital/nursingAssignment.ts` | event (a) | `NurseAssigned` | 5 |
| `endAssignment` | `src/lib/hospital/nursingAssignment.ts` | event (a) | `NurseAssignmentEnded` | 5 |
| `updateTask` | `src/lib/hospital/task.ts` | event (a) | `TaskUpdated` | 5 |

### Step 6: Orders, results, medication, pharmacy, ICU, care plans (34 functions)

| Function | File | Decision | Proposed event | Step |
|---|---|---|---|---|
| `addIntervention` | `src/lib/hospital/carePlan.ts` | event (a) | `CarePlanUpdated` | 6 |
| `closeCarePlan` | `src/lib/hospital/carePlan.ts` | event (a) | `CarePlanClosed` | 6 |
| `completeIntervention` | `src/lib/hospital/carePlan.ts` | event (a) | `CarePlanUpdated` | 6 |
| `createCarePlan` | `src/lib/hospital/carePlan.ts` | event (a) | `CarePlanCreated` | 6 |
| `createExternalReferral` | `src/lib/hospital/diagnosticsAdvanced.ts` | event (a) | `ExternalLabReferralCreated` | 6 |
| `transitionExternalReferral` | `src/lib/hospital/diagnosticsAdvanced.ts` | event (a) | `ExternalLabReferralStatusChanged` | 6 |
| `recordDevice` | `src/lib/hospital/icu.ts` | event (a) | `IcuDeviceRecorded` | 6 |
| `recordInfusion` | `src/lib/hospital/icu.ts` | event (a) | `IcuInfusionStarted` | 6 |
| `recordObservation` | `src/lib/hospital/icu.ts` | event (a) — one event type for point-of-care observations, with an observation-kind code | `ObservationRecorded` | 6 |
| `updateDeviceStatus` | `src/lib/hospital/icu.ts` | event (a) | `IcuDeviceStatusChanged` | 6 |
| `updateInfusionStatus` | `src/lib/hospital/icu.ts` | event (a) | `IcuInfusionStatusChanged` | 6 |
| `amendReport` | `src/lib/hospital/imagingReportLifecycle.ts` | event (a) | `ImagingReportAmended` | 6 |
| `cancelStudy` | `src/lib/hospital/imagingStudyLifecycle.ts` | event (a) | `ImagingStudyCancelled` | 6 |
| `rescheduleStudy` | `src/lib/hospital/imagingStudyLifecycle.ts` | event (a) | `ImagingStudyScheduled` | 6 |
| `scheduleStudy` | `src/lib/hospital/imagingStudyLifecycle.ts` | event (a) | `ImagingStudyScheduled` | 6 |
| `amendResult` | `src/lib/hospital/labResultLifecycle.ts` | event (a) | `LabResultAmended` | 6 |
| `acknowledgeSafetyWarning` | `src/lib/hospital/medicationLifecycle.ts` | event (d) | `MedicationSafetyWarningOverridden` | 6 |
| `cancelMedicationOrder` | `src/lib/hospital/medicationLifecycle.ts` | event (a) | `MedicationOrderCancelled` | 6 |
| `discontinueMedicationOrder` | `src/lib/hospital/medicationLifecycle.ts` | event (a) | `MedicationDiscontinued` | 6 |
| `holdMedicationOrder` | `src/lib/hospital/medicationLifecycle.ts` | event (a) | `MedicationOrderHeld` | 6 |
| `rejectMedicationOrder` | `src/lib/hospital/medicationLifecycle.ts` | event (a) | `MedicationOrderRejected` | 6 |
| `requestClarification` | `src/lib/hospital/medicationLifecycle.ts` | event (a) | `MedicationClarificationRequested` | 6 |
| `resubmitMedicationOrder` | `src/lib/hospital/medicationLifecycle.ts` | event (a) | `MedicationOrderResubmitted` | 6 |
| `closeRecall` | `src/lib/hospital/pharmacy.ts` | event (d) | `MedicationRecallClosed` | 6 |
| `createRecall` | `src/lib/hospital/pharmacy.ts` | event (d) | `MedicationRecallIssued` | 6 |
| `quarantinePharmacyLot` | `src/lib/hospital/pharmacy.ts` | event (d) | `StockLotQuarantined` | 6 |
| `recordControlledWastage` | `src/lib/hospital/pharmacy.ts` | event (d) — regulatory fact; the stock movement is StockMoved | `ControlledDrugWasted` | 6 |
| `recordStorageCheck` | `src/lib/hospital/pharmacy.ts` | event (d) — an EXCURSION is the safety fact | `StorageCheckRecorded` | 6 |
| `recordSubstitution` | `src/lib/hospital/pharmacy.ts` | event (a) | `MedicationSubstituted` | 6 |
| `releasePharmacyQuarantine` | `src/lib/hospital/pharmacy.ts` | event (d) | `StockLotReleased` | 6 |
| `addDiagnosisToProblemList` | `src/lib/hospital/problemList.ts` | event (a) | `ProblemListUpdated` | 6 |
| `recordReconciliation` | `src/lib/hospital/reconciliation.ts` | event (a) | `MedicationReconciliationRecorded` | 6 |
| `recollectSpecimen` | `src/lib/hospital/specimenLifecycle.ts` | event (a) | `SpecimenRecollectionRequested` | 6 |
| `rejectSpecimen` | `src/lib/hospital/specimenLifecycle.ts` | event (a) — the patient must be re-sampled | `SpecimenRejected` | 6 |

### Step 7: Patient access, consent and record (10 functions)

| Function | File | Decision | Proposed event | Step |
|---|---|---|---|---|
| `closeConsentRequest` | `src/lib/consent/lifecycle.ts` | event (c) | `ConsentRequestClosed` | 7 |
| `expireLapsedConsents` | `src/lib/consent/lifecycle.ts` | event (c) | `ConsentExpired` | 7 |
| `requestConsent` | `src/lib/consent/lifecycle.ts` | event (c) | `ConsentRequested` | 7 |
| `endAccessSession` | `src/lib/patient/accessSession.ts` | event (c) | `PatientAccessEnded` | 7 |
| `extendAccessSession` | `src/lib/patient/accessSession.ts` | event (c) | `PatientAccessExtended` | 7 |
| `issueAccessCode` | `src/lib/patient/accessSession.ts` | event (c) | `PatientAccessCodeIssued` | 7 |
| `redeemAccessCode` | `src/lib/patient/accessSession.ts` | event (c) | `PatientAccessGranted` | 7 |
| `updateProfile` | `src/lib/patient/experience/profile.ts` | event (a) | `PatientProfileUpdated` | 7 |
| `addPatientIdentifier` | `src/lib/patient/identifiers.ts` | event (a) | `PatientIdentifierAdded` | 7 |
| `verifyLinkOtp` | `src/lib/patient/selfRegistration.ts` | event (c) — links a portal account to a record | `PatientAccountLinked` | 7 |

### Step 8: Operating theatre and blood bank (22 functions)

| Function | File | Decision | Proposed event | Step |
|---|---|---|---|---|
| `authorizeEmergencyRelease` | `src/lib/hospital/blood.ts` | event (d) | `EmergencyBloodReleaseAuthorized` | 8 |
| `quarantineUnit` | `src/lib/hospital/blood.ts` | event (d) | `BloodUnitQuarantined` | 8 |
| `recallUnit` | `src/lib/hospital/blood.ts` | event (d) | `BloodUnitRecalled` | 8 |
| `recordPatientTyping` | `src/lib/hospital/blood.ts` | event (a) | `PatientBloodTypeRecorded` | 8 |
| `recordTransfusionObservation` | `src/lib/hospital/blood.ts` | event (a) | `ObservationRecorded` | 8 |
| `registerBloodUnit` | `src/lib/hospital/blood.ts` | event (b) | `BloodUnitRegistered` | 8 |
| `releaseReservation` | `src/lib/hospital/blood.ts` | event (b) | `BloodReservationReleased` | 8 |
| `releaseUnit` | `src/lib/hospital/blood.ts` | event (b) | `BloodUnitReleased` | 8 |
| `requestBlood` | `src/lib/hospital/blood.ts` | event (a) | `BloodRequested` | 8 |
| `reserveUnits` | `src/lib/hospital/blood.ts` | event (b) | `BloodUnitsReserved` | 8 |
| `returnUnit` | `src/lib/hospital/blood.ts` | event (b) | `BloodUnitReturned` | 8 |
| `transitionReaction` | `src/lib/hospital/blood.ts` | event (d) | `TransfusionReactionStatusChanged` | 8 |
| `transitionRequest` | `src/lib/hospital/blood.ts` | event (a) | `BloodRequestStatusChanged` | 8 |
| `transitionTransfusion` | `src/lib/hospital/blood.ts` | event (a) | `TransfusionStatusChanged` | 8 |
| `verifyCompatibility` | `src/lib/hospital/blood.ts` | event (a) | `CrossmatchVerified` | 8 |
| `wasteUnit` | `src/lib/hospital/blood.ts` | event (b) | `BloodUnitWasted` | 8 |
| `cancelSchedule` | `src/lib/hospital/surgery.ts` | event (a) | `SurgeryScheduleCancelled` | 8 |
| `collectSpecimen` | `src/lib/hospital/surgery.ts` | event (a) | `SurgicalSpecimenCollected` | 8 |
| `recordAnesthesia` | `src/lib/hospital/surgery.ts` | event (a) | `AnesthesiaRecorded` | 8 |
| `transitionSurgery` | `src/lib/hospital/surgery.ts` | event (a) | `SurgeryStatusChanged` | 8 |
| `updateChecklistItem` | `src/lib/hospital/surgery.ts` | event (d) | `SurgicalSafetyChecklistUpdated` | 8 |
| `updateRecovery` | `src/lib/hospital/surgery.ts` | event (a) | `RecoveryStatusChanged` | 8 |

### Step 9: Billing, claims and NHCX (25 functions)

| Function | File | Decision | Proposed event | Step |
|---|---|---|---|---|
| `applyCreditToInvoice` | `src/lib/billing/credits.ts` | event (b) | `CreditApplied` | 9 |
| `issueCredit` | `src/lib/billing/credits.ts` | event (b) | `CreditIssued` | 9 |
| `voidInvoice` | `src/lib/billing/invoices.ts` | event (b) | `InvoiceVoided` | 9 |
| `resolveException` | `src/lib/billing/reconciliation.ts` | event (b) — the existing event, from this second path | `ReconciliationExceptionResolved` | 9 |
| `transitionSubscription` | `src/lib/commercial/subscriptions.ts` | event (c) — entitlements follow the subscription | `SubscriptionStatusChanged` | 9 |
| `approveAdjustment` | `src/lib/hospital/billing/adjustments.ts` | event (b) | `BillingAdjustmentApproved` | 9 |
| `voidCharge` | `src/lib/hospital/billing/chargeCapture.ts` | event (b) | `ChargeVoided` | 9 |
| `closeClaim` | `src/lib/hospital/billing/claims.ts` | event (b) | `ClaimClosed` | 9 |
| `recordClaimDecision` | `src/lib/hospital/billing/claims.ts` | event (b) | `ClaimDecisionRecorded` | 9 |
| `submitClaim` | `src/lib/hospital/billing/claims.ts` | event (b) — the non-NHCX submission path | `ClaimSubmitted` | 9 |
| `addPatientCoverage` | `src/lib/hospital/billing/coverage.ts` | event (b) | `CoverageAdded` | 9 |
| `deactivateCoverage` | `src/lib/hospital/billing/coverage.ts` | event (b) | `CoverageDeactivated` | 9 |
| `voidInvoice` | `src/lib/hospital/billing/invoices.ts` | event (b) | `HospitalInvoiceVoided` | 9 |
| `allocatePayment` | `src/lib/hospital/billing/payments.ts` | event (b) | `PaymentAllocated` | 9 |
| `voidPayment` | `src/lib/hospital/billing/payments.ts` | event (b) | `HospitalPaymentVoided` | 9 |
| `expirePreAuth` | `src/lib/hospital/billing/preauth.ts` | event (b) | `PreauthExpired` | 9 |
| `requestPreAuth` | `src/lib/hospital/billing/preauth.ts` | event (b) | `PreauthRequested` | 9 |
| `completeRefund` | `src/lib/hospital/billing/refunds.ts` | event (b) | `HospitalRefundCompleted` | 9 |
| `recordQuery` | `src/lib/hospital/nhcx/queries.ts` | event (b) | `ClaimQueryReceived` | 9 |
| `respondToQuery` | `src/lib/hospital/nhcx/queries.ts` | event (b) | `ClaimQueryResponded` | 9 |
| `transitionQuery` | `src/lib/hospital/nhcx/queries.ts` | event (b) | `ClaimQueryStatusChanged` | 9 |
| `raiseException` | `src/lib/hospital/nhcx/reconciliation.ts` | event (b) | `ClaimReconciliationExceptionRaised` | 9 |
| `reconcileSettlement` | `src/lib/hospital/nhcx/reconciliation.ts` | event (b) | `ClaimSettlementReconciled` | 9 |
| `recordSettlement` | `src/lib/hospital/nhcx/reconciliation.ts` | event (b) | `ClaimSettlementNotified` | 9 |
| `resolveException` | `src/lib/hospital/nhcx/reconciliation.ts` | event (b) | `ClaimReconciliationExceptionResolved` | 9 |

### Step 9a: Inventory and procurement (23 functions)

| Function | File | Decision | Proposed event | Step |
|---|---|---|---|---|
| `approveAdjustment` | `src/lib/hospital/inventory/adjustment.ts` | event (b) | `StockMoved (via postLedgerEntry)` | 9a |
| `createAdjustment` | `src/lib/hospital/inventory/adjustment.ts` | event (b) | `StockMoved (via postLedgerEntry)` | 9a |
| `registerSerial` | `src/lib/hospital/inventory/inventoryAdvanced.ts` | event (b) | `SerialUnitRegistered` | 9a |
| `transitionDepartmentRequest` | `src/lib/hospital/inventory/inventoryAdvanced.ts` | event (b) | `StockMoved (via issueStock / reserveStock)` | 9a |
| `transitionSerial` | `src/lib/hospital/inventory/inventoryAdvanced.ts` | event (b) | `SerialUnitStatusChanged` | 9a |
| `quarantineLot` | `src/lib/hospital/inventory/lots.ts` | event (d) | `StockLotQuarantined` | 9a |
| `releaseLotFromQuarantine` | `src/lib/hospital/inventory/lots.ts` | event (d) | `StockLotReleased` | 9a |
| `consumeReservation` | `src/lib/hospital/inventory/reservation.ts` | event (b) | `StockMoved (via postLedgerEntry)` | 9a |
| `releaseReservation` | `src/lib/hospital/inventory/reservation.ts` | event (b) | `StockMoved (via postLedgerEntry)` | 9a |
| `reserveStock` | `src/lib/hospital/inventory/reservation.ts` | event (b) | `StockMoved (via postLedgerEntry)` | 9a |
| `completeStockTake` | `src/lib/hospital/inventory/stocktake.ts` | event (b) — variances are posted as StockMoved | `StockTakeCompleted` | 9a |
| `cancelTransfer` | `src/lib/hospital/inventory/transfer.ts` | event (b) | `StockMoved (via postLedgerEntry)` | 9a |
| `initiateTransfer` | `src/lib/hospital/inventory/transfer.ts` | event (b) | `StockMoved (via postLedgerEntry)` | 9a |
| `receiveTransfer` | `src/lib/hospital/inventory/transfer.ts` | event (b) | `StockMoved (via postLedgerEntry)` | 9a |
| `recordWaste` | `src/lib/hospital/inventory/waste.ts` | event (b) | `StockMoved (via postLedgerEntry)` | 9a |
| `classifyMedicationReturn` | `src/lib/hospital/pharmacy.ts` | event (b) | `StockMoved (via postLedgerEntry)` | 9a |
| `createPharmacyTransfer` | `src/lib/hospital/pharmacy.ts` | event (b) | `StockMoved (via initiateTransfer)` | 9a |
| `transitionPharmacyRequest` | `src/lib/hospital/pharmacy.ts` | event (b) | `StockMoved (via reserveStock / issueStock)` | 9a |
| `recordSupplierInvoice` | `src/lib/hospital/procurement/procurementAdvanced.ts` | event (b) | `SupplierInvoiceRecorded` | 9a |
| `reviewSupplierInvoice` | `src/lib/hospital/procurement/procurementAdvanced.ts` | event (b) | `SupplierInvoiceReviewed` | 9a |
| `approvePurchaseOrder` | `src/lib/hospital/procurement/purchaseOrders.ts` | event (b) — commits money to a supplier | `PurchaseOrderApproved` | 9a |
| `cancelPurchaseOrder` | `src/lib/hospital/procurement/purchaseOrders.ts` | event (b) | `PurchaseOrderCancelled` | 9a |
| `closePurchaseOrder` | `src/lib/hospital/procurement/purchaseOrders.ts` | event (b) | `PurchaseOrderClosed` | 9a |

### Step 9b: Quality, safety and operations (27 functions)

| Function | File | Decision | Proposed event | Step |
|---|---|---|---|---|
| `recordCalibration` | `src/lib/hospital/diagnosticsAdvanced.ts` | event (d) | `LabCalibrationRecorded` | 9b |
| `recordQc` | `src/lib/hospital/diagnosticsAdvanced.ts` | event (d) — payload carries the outcome; a failure is the quality fact | `LabQcRecorded` | 9b |
| `reviewCalibration` | `src/lib/hospital/diagnosticsAdvanced.ts` | event (d) | `LabCalibrationReviewed` | 9b |
| `reviewQc` | `src/lib/hospital/diagnosticsAdvanced.ts` | event (d) | `LabQcReviewed` | 9b |
| `completePreventiveMaintenance` | `src/lib/hospital/operations/service.ts` | event (d) | `EquipmentMaintenanceRecorded` | 9b |
| `createDietOrder` | `src/lib/hospital/operations/service.ts` | event (a) | `DietOrderPlaced` | 9b |
| `createInfectionIncident` | `src/lib/hospital/operations/service.ts` | event (d) | `InfectionIncidentReported` | 9b |
| `createInfectionInvestigation` | `src/lib/hospital/operations/service.ts` | event (d) | `InfectionInvestigationOpened` | 9b |
| `createMaintenanceRequest` | `src/lib/hospital/operations/service.ts` | event (d) — an equipment or facility fault | `MaintenanceRequestRaised` | 9b |
| `endDowntime` | `src/lib/hospital/operations/service.ts` | event (d) | `EquipmentDowntimeEnded` | 9b |
| `recordEquipmentCalibration` | `src/lib/hospital/operations/service.ts` | event (d) | `EquipmentCalibrationRecorded` | 9b |
| `recordEquipmentMaintenance` | `src/lib/hospital/operations/service.ts` | event (d) | `EquipmentMaintenanceRecorded` | 9b |
| `recordExposure` | `src/lib/hospital/operations/service.ts` | event (d) | `InfectionExposureRecorded` | 9b |
| `setDietOrderStatus` | `src/lib/hospital/operations/service.ts` | event (a) | `DietOrderStatusChanged` | 9b |
| `setEquipmentStatus` | `src/lib/hospital/operations/service.ts` | event (d) | `EquipmentStatusChanged` | 9b |
| `startDowntime` | `src/lib/hospital/operations/service.ts` | event (d) | `EquipmentDowntimeStarted` | 9b |
| `transitionInfectionIncident` | `src/lib/hospital/operations/service.ts` | event (d) | `InfectionIncidentStatusChanged` | 9b |
| `transitionMaintenance` | `src/lib/hospital/operations/service.ts` | event (d) | `MaintenanceRequestStatusChanged` | 9b |
| `closeFinding` | `src/lib/hospital/quality/service.ts` | event (d) | `QualityFindingClosed` | 9b |
| `createCapa` | `src/lib/hospital/quality/service.ts` | event (d) | `CapaRaised` | 9b |
| `createFinding` | `src/lib/hospital/quality/service.ts` | event (d) | `QualityFindingRaised` | 9b |
| `createQualityIncident` | `src/lib/hospital/quality/service.ts` | event (d) | `QualityIncidentReported` | 9b |
| `reopenIncident` | `src/lib/hospital/quality/service.ts` | event (d) | `QualityIncidentStatusChanged` | 9b |
| `reviewRca` | `src/lib/hospital/quality/service.ts` | event (d) | `RootCauseAnalysisReviewed` | 9b |
| `setMeasureStatus` | `src/lib/hospital/quality/service.ts` | event (d) | `QualityMeasureStatusChanged` | 9b |
| `transitionCapa` | `src/lib/hospital/quality/service.ts` | event (d) | `CapaStatusChanged` | 9b |
| `transitionIncident` | `src/lib/hospital/quality/service.ts` | event (d) | `QualityIncidentStatusChanged` | 9b |

### Step 9c: Access, identity, interoperability and workforce (14 functions)

| Function | File | Decision | Proposed event | Step |
|---|---|---|---|---|
| `activateBreakGlass` | `src/lib/auth/authorize/breakGlass.ts` | event (c) | `BreakGlassActivated` | 9c |
| `expireLapsedBreakGlass` | `src/lib/auth/authorize/breakGlass.ts` | event (c) | `BreakGlassExpired` | 9c |
| `createPrivacyRequest` | `src/lib/auth/authorize/privacy.ts` | event (a) — a DPDP data-subject request about the patient's record | `PrivacyRequestSubmitted` | 9c |
| `setLegalHold` | `src/lib/auth/authorize/privacy.ts` | event (a) — changes how the record may be erased | `LegalHoldSet` | 9c |
| `transitionPrivacyRequest` | `src/lib/auth/authorize/privacy.ts` | event (a) | `PrivacyRequestStatusChanged` | 9c |
| `createExchange` | `src/lib/hospital/interoperability/exchange.ts` | event (c) — a disclosure of the record to another party | `HealthInformationExchangeRequested` | 9c |
| `linkExternalIdentifier` | `src/lib/hospital/interoperability/externalIdentity.ts` | event (a) | `ExternalIdentifierLinked` | 9c |
| `unlinkExternalIdentifier` | `src/lib/hospital/interoperability/externalIdentity.ts` | event (a) | `ExternalIdentifierUnlinked` | 9c |
| `verifyExternalIdentifier` | `src/lib/hospital/interoperability/externalIdentity.ts` | event (a) | `ExternalIdentifierVerified` | 9c |
| `reviewImportedResource` | `src/lib/hospital/interoperability/fhir/import.ts` | event (a) — accepted imports enter the record | `ImportedResourceReviewed` | 9c |
| `createAssignment` | `src/lib/hospital/workforce/service.ts` | event (c) — department assignment scopes what staff can act on | `StaffAssignmentChanged` | 9c |
| `createCredential` | `src/lib/hospital/workforce/service.ts` | event (c) — credentials gate prescribing and sign-off | `StaffCredentialRecorded` | 9c |
| `endAssignment` | `src/lib/hospital/workforce/service.ts` | event (c) | `StaffAssignmentChanged` | 9c |
| `grantPrivilege` | `src/lib/hospital/workforce/service.ts` | event (c) | `StaffPrivilegeGranted` | 9c |

## Named exemptions

### `PROCESS_STEP` (47)

| Function | File | Reason |
|---|---|---|
| `addInvoiceLine` | `src/lib/billing/invoices.ts` | edit to a draft invoice; money moves on InvoiceFinalized |
| `createPaymentAttempt` | `src/lib/billing/payments.ts` | an attempt; its outcome is PaymentReceived / PaymentFailed |
| `createAdjustment` | `src/lib/hospital/billing/adjustments.ts` | adjustment request awaiting approval |
| `rejectAdjustment` | `src/lib/hospital/billing/adjustments.ts` | rejected request; nothing moves |
| `addChargeToInvoice` | `src/lib/hospital/billing/invoices.ts` | edit to a draft invoice |
| `draftInvoiceForAccount` | `src/lib/hospital/billing/invoices.ts` | draft invoice; money moves on HospitalInvoiceIssued |
| `approveRefund` | `src/lib/hospital/billing/refunds.ts` | approval step; money moves on completion |
| `rejectRefund` | `src/lib/hospital/billing/refunds.ts` | rejected request; nothing moves |
| `requestRefund` | `src/lib/hospital/billing/refunds.ts` | refund request; money moves on completion |
| `recordCompatibility` | `src/lib/hospital/blood.ts` | crossmatch entry; verification is the event |
| `recordUnitTyping` | `src/lib/hospital/blood.ts` | lab check on a unit; releasing the unit is the event |
| `recordStudyAcquisition` | `src/lib/hospital/diagnosticsAdvanced.ts` | acquisition metadata; ImagingStudyCompleted is the event |
| `setSpecimenIdentity` | `src/lib/hospital/diagnosticsAdvanced.ts` | labelling check inside collection; SpecimenCollected is the event |
| `enterReport` | `src/lib/hospital/imagingReportLifecycle.ts` | unverified report; ImagingReportReleased is the event |
| `importFhirPayload` | `src/lib/hospital/interoperability/fhir/import.ts` | stages inbound resources for review; the record changes only when one is accepted (ImportedResourceReviewed) |
| `rejectAdjustment` | `src/lib/hospital/inventory/adjustment.ts` | rejected adjustment; nothing moves |
| `createDepartmentRequest` | `src/lib/hospital/inventory/inventoryAdvanced.ts` | department request; stock moves when it is fulfilled |
| `addStockTakeLine` | `src/lib/hospital/inventory/stocktake.ts` | count in progress |
| `startStockTake` | `src/lib/hospital/inventory/stocktake.ts` | count in progress; variances move stock on completion |
| `approveWaste` | `src/lib/hospital/inventory/waste.ts` | approval of an already-recorded waste movement |
| `rejectWaste` | `src/lib/hospital/inventory/waste.ts` | rejected waste |
| `enterResult` | `src/lib/hospital/labResultLifecycle.ts` | unverified entry; LabResultReleased is the event |
| `buildSubmission` | `src/lib/hospital/nhcx/submission.ts` | builds the package; ClaimSubmitted is the event |
| `createAssessment` | `src/lib/hospital/nursingAssessment.ts` | draft; the record changes when it is completed or signed |
| `createMedicationReturn` | `src/lib/hospital/pharmacy.ts` | a return awaiting classification; stock moves on classification |
| `createPharmacyRequest` | `src/lib/hospital/pharmacy.ts` | ward request; stock moves when it is fulfilled |
| `recordGoodsReceipt` | `src/lib/hospital/procurement/goodsReceipts.ts` | receipt awaiting approval; GoodsReceived on approval |
| `rejectGoodsReceipt` | `src/lib/hospital/procurement/goodsReceipts.ts` | rejected receipt; nothing moves |
| `createRfq` | `src/lib/hospital/procurement/procurementAdvanced.ts` | sourcing; no money or stock moves |
| `recordQuotation` | `src/lib/hospital/procurement/procurementAdvanced.ts` | sourcing; no money or stock moves |
| `selectQuotation` | `src/lib/hospital/procurement/procurementAdvanced.ts` | sourcing; the PO commits money |
| `transitionRfq` | `src/lib/hospital/procurement/procurementAdvanced.ts` | sourcing; no money or stock moves |
| `addPurchaseOrderLine` | `src/lib/hospital/procurement/purchaseOrders.ts` | draft PO |
| `createPurchaseOrderDraft` | `src/lib/hospital/procurement/purchaseOrders.ts` | draft PO |
| `markSent` | `src/lib/hospital/procurement/purchaseOrders.ts` | PO dispatch step |
| `submitForApproval` | `src/lib/hospital/procurement/purchaseOrders.ts` | PO approval step |
| `addRequisitionLine` | `src/lib/hospital/procurement/requisitions.ts` | internal requisition |
| `approveRequisition` | `src/lib/hospital/procurement/requisitions.ts` | internal requisition; the PO commits money |
| `cancelRequisition` | `src/lib/hospital/procurement/requisitions.ts` | internal requisition |
| `createRequisitionDraft` | `src/lib/hospital/procurement/requisitions.ts` | internal requisition; no money moves |
| `rejectRequisition` | `src/lib/hospital/procurement/requisitions.ts` | internal requisition |
| `reviseApprovedRequisition` | `src/lib/hospital/procurement/requisitions.ts` | internal requisition |
| `submitRequisition` | `src/lib/hospital/procurement/requisitions.ts` | internal requisition |
| `createRca` | `src/lib/hospital/quality/service.ts` | root-cause analysis draft |
| `updateRca` | `src/lib/hospital/quality/service.ts` | root-cause analysis draft |
| `acceptSpecimen` | `src/lib/hospital/specimenLifecycle.ts` | lab receipt step between collection and result |
| `inviteDelegate` | `src/lib/patient/experience/family.ts` | an invitation grants nothing; access starts on acceptance (FamilyAccessGranted) |

### `OPERATIONAL_DETAIL` (35)

| Function | File | Reason |
|---|---|---|
| `updateBillingAccount` | `src/lib/billing/billingAccount.ts` | billing contact details; no money moves |
| `recordCollectionActivity` | `src/lib/commercial/analytics/collections.ts` | collections note |
| `assignException` | `src/lib/commercial/analytics/reconciliationIntel.ts` | assigns an exception to an operator |
| `completeBedCleaning` | `src/lib/hospital/admission.ts` | bed housekeeping state; patient moves are their own events |
| `transitionBed` | `src/lib/hospital/bed.ts` | bed status; patient placement is PatientTransferred / AdmissionCreated |
| `dispatchIssue` | `src/lib/hospital/blood.ts` | transport leg of an issued unit; BloodIssued is the event |
| `receiveIssue` | `src/lib/hospital/blood.ts` | transport leg of an issued unit; BloodIssued is the event |
| `raiseAlert` | `src/lib/hospital/interoperability/controlPlane/alerts.ts` | integration health alert for operators |
| `resolveAlertsByType` | `src/lib/hospital/interoperability/controlPlane/alerts.ts` | integration health alert for operators |
| `transitionAlert` | `src/lib/hospital/interoperability/controlPlane/alerts.ts` | integration health alert for operators |
| `createAmbulanceTrip` | `src/lib/hospital/operations/service.ts` | fleet logistics |
| `createHousekeepingRequest` | `src/lib/hospital/operations/service.ts` | housekeeping logistics |
| `createTransportRequest` | `src/lib/hospital/operations/service.ts` | porter/transport logistics; location changes are their own events |
| `dispatchAmbulanceTrip` | `src/lib/hospital/operations/service.ts` | fleet logistics |
| `moveEquipment` | `src/lib/hospital/operations/service.ts` | equipment location |
| `planMeal` | `src/lib/hospital/operations/service.ts` | kitchen meal planning |
| `schedulePreventiveMaintenance` | `src/lib/hospital/operations/service.ts` | maintenance schedule |
| `setAmbulanceStatus` | `src/lib/hospital/operations/service.ts` | fleet logistics |
| `transitionAmbulanceTrip` | `src/lib/hospital/operations/service.ts` | fleet logistics |
| `transitionHousekeeping` | `src/lib/hospital/operations/service.ts` | housekeeping logistics |
| `transitionMeal` | `src/lib/hospital/operations/service.ts` | meal delivery logistics |
| `transitionTransport` | `src/lib/hospital/operations/service.ts` | porter/transport logistics |
| `attachEvidence` | `src/lib/hospital/quality/service.ts` | compliance evidence attachment |
| `createAudit` | `src/lib/hospital/quality/service.ts` | audit scheduling |
| `transitionAudit` | `src/lib/hospital/quality/service.ts` | audit progress; its findings are the events |
| `callNext` | `src/lib/hospital/queue.ts` | queue token state, deliberately not an event (§1.2: QueueTokenCalled) |
| `cancelQueueEntry` | `src/lib/hospital/queue.ts` | queue token state, deliberately not an event (§1.2) |
| `completeQueueEntry` | `src/lib/hospital/queue.ts` | queue token state, deliberately not an event (§1.2) |
| `enterQueue` | `src/lib/hospital/queue.ts` | queue token state, deliberately not an event (§1.2) |
| `skipQueueEntry` | `src/lib/hospital/queue.ts` | queue token state, deliberately not an event (§1.2) |
| `startService` | `src/lib/hospital/queue.ts` | queue token state, deliberately not an event (§1.2) |
| `setTeamMember` | `src/lib/hospital/surgery.ts` | theatre team roster for the case |
| `cancelShift` | `src/lib/hospital/workforce/service.ts` | roster entry; bookability reads it directly |
| `createShift` | `src/lib/hospital/workforce/service.ts` | roster entry; bookability reads it directly |
| `setAvailability` | `src/lib/hospital/workforce/service.ts` | staff availability (StaffAbsence); bookability reads it directly |

### `INTEGRATION_PROTOCOL` (7)

| Function | File | Reason |
|---|---|---|
| `setProviderCustomerRef` | `src/lib/billing/billingAccount.ts` | payment-provider customer reference |
| `syncProviderCustomer` | `src/lib/billing/billingAccount.ts` | payment-provider customer sync |
| `ingestWebhook` | `src/lib/billing/webhooks.ts` | inbound webhook log; the changes it causes emit their own events |
| `receiveCallback` | `src/lib/hospital/interoperability/abdm/callbacks.ts` | inbound ABDM callback log; the state changes it causes emit their own events |
| `receiveCallback` | `src/lib/hospital/nhcx/callbacks.ts` | inbound NHCX callback log; the changes it causes emit their own events |
| `retryExchange` | `src/lib/hospital/nhcx/submission.ts` | protocol retry of an exchange |
| `transitionExchange` | `src/lib/hospital/nhcx/submission.ts` | protocol state of an exchange; the claim's status change is its own event |

### `CONSUMER_OUTPUT` (2)

| Function | File | Reason |
|---|---|---|
| `updateDischargeReadiness` | `src/lib/hospital/admission.ts` | written by the discharge-readiness consumer; readiness is derived from events |
| `generateAdministrationSchedule` | `src/lib/hospital/medicationSchedule.ts` | becomes the mar-scheduler consumer's write (reacting to MedicationVerified) |

### `BOOKKEEPING` (1)

| Function | File | Reason |
|---|---|---|
| `accessionSpecimen` | `src/lib/hospital/specimenLifecycle.ts` | runs inside placeLabOrder's transaction; LabOrderPlaced covers it |

### `REFERENCE_DATA` (1)

| Function | File | Reason |
|---|---|---|
| `createEquipment` | `src/lib/hospital/operations/service.ts` | equipment register entry |

## After approval

1. `emitExemptions.ts`: each function above moves from `NOT_YET_CATALOGUED` to `PLANNED` (event + step) or to its exemption category. `NOT_YET_CATALOGUED` is then empty and is removed from the allowed categories, so the CI rule rejects it.
2. The new events are added to `catalogue.ts` and wired in their module's step; each step removes its `PLANNED` entries.
