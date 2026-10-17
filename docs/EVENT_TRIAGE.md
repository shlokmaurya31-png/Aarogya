# Event triage: the "not yet catalogued" writes

- **Date:** 2026-10-15 (Week 3; round 2, consolidated after review)
- **Status:** approved 2026-10-16 with the four changes below, which this document now reflects. Batch 3a applied it to `emitExemptions.ts` (`NOT_YET_CATALOGUED` is 0 and the CI rule rejects the category); each module's step wires its events.
- **Scope:** every exported service function the CI emit rule lists as `NOT_YET_CATALOGUED`. Round 1 triaged 275. Since then three left the category: `completeTransferRequest` and `ingestWebhook` now reach registered emitting helpers (`transferPatientInTx`, `emitPaymentFailed`), and `addIntervention` moved to `OWED_EVENTS` (it emits TaskCreated but still owes `CarePlanUpdated`). **272** remain.

## Approved changes (2026-10-16)

1. **Settlements emit `ClaimSettled`** (planned #59), not `ClaimReconciliationStatusChanged`: `recordSettlement` (the NHCX settlement notification) and `reconcileSettlement` join `settleClaim` as its producers. `ClaimReconciliationStatusChanged` covers reconciliation exceptions only (`raiseException`, `resolveException`). Because three functions now emit `ClaimSettled`, step 9 gives its payload a closed `stage` code (SETTLED \| NOTIFIED \| RECONCILED) and an optional `settlementId`, so `discharge-readiness` can tell them apart.
2. **Cross-aggregate merges carry a closed type code.** `StockDocumentStatusChanged.documentType` = ADJUSTMENT \| WASTE \| GOODS_RECEIPT \| STOCK_TAKE; `StaffAuthorizationChanged.changeType` = DEPARTMENT \| CREDENTIAL \| PRIVILEGE, plus `subjectStaffId`. The surgery-recovery fold and the RCA fold stand as written.
3. **Sensitivity.** See *Sensitivity* below.
4. **Waste flow** changes at step 9a (HOLD on record, write-off on approval, return on rejection). See *Other notes*.

## Sensitivity

`SENSITIVE` (the fact itself is sensitive: operator views show type and IDs only, and only clinical consumers receive it). Enforced by `SENSITIVE_EVENTS` in `emitExemptions.ts`: a catalogued contract with one of these names must be `SENSITIVE`.

- Already marked in the design: `ConsentGranted`, `ConsentRevoked`, `MedicationDoseMissed`, `TransfusionReactionReported`, `FamilyAccessGranted`, `FamilyAccessRevoked`.
- Approved change 3: `ResuscitationStatusChanged`, `BreakGlassStatusChanged`, `LegalHoldSet`, `PrivacyRequestStatusChanged`, `InfectionExposureRecorded`.
- Confirmed 2026-10-16 (batch 4, decision 4): `ConsentExpired` (a consent fact, like `ConsentRevoked`) and `TransfusionReactionStatusChanged` (the lifecycle of a reported reaction).
- Batch 4, decision 2: `MedicationDoseNotGiven` (a refused or held dose).

Every other event is `INTERNAL` (clinical/operational IDs about a patient) or `LOW` (commercial).

## Rules applied

A function **becomes a planned event** if it (a) changes a patient's care or record, (b) moves money or stock, (c) changes access or permissions, or (d) is a safety or quality fact. Otherwise it gets a named exemption with a one-line reason.

Naming (round 2):

- **One event per state-machine aggregate:** `<Aggregate>StatusChanged`, payload `from` / `to` (closed enums, `from` null on creation), unless a listed consumer (existing, planned, or `rag-indexer`) subscribes to that specific transition. Those exceptions are listed under *Kept specific*.
- **One `<Thing>Recorded` per kind of repeated clinical documentation**, with a type code (e.g. `NursingAssessmentRecorded` with `assessmentType` and `stage` = COMPLETED | SIGNED | AMENDED, `supersedesAssessmentId?`).
- **The 46 planned names are kept** as they are.
- **`PROCESS_STEP` only when the process's outcome is emitted at its boundary event.** Each one names its boundary. Where an outcome (usually a rejection) had no boundary event, the function became an event.

| Exemption category | Meaning |
|---|---|
| `PROCESS_STEP` | An intermediate step (draft, request, pending approval) whose outcome is emitted by the named boundary event. |
| `OPERATIONAL_DETAIL` | Logistics or housekeeping with no effect on care, money, stock, access or safety. |
| `INTEGRATION_PROTOCOL` | Inbound callback logs and protocol state of external exchanges; the changes they cause emit their own events. |
| `CONSUMER_OUTPUT` | Written by an event consumer in reaction to another event. |

## Counts

| | Count |
|---|---|
| **Functions triaged** | **272** |
| Become planned events | 186 |
| &nbsp;&nbsp;(a) care or record | 74 |
| &nbsp;&nbsp;(b) money or stock | 57 |
| &nbsp;&nbsp;(c) access or permissions | 16 |
| &nbsp;&nbsp;(d) safety or quality | 39 |
| Named exemptions | 86 |
| &nbsp;&nbsp;`OPERATIONAL_DETAIL` | 46 |
| &nbsp;&nbsp;`PROCESS_STEP` | 30 |
| &nbsp;&nbsp;`INTEGRATION_PROTOCOL` | 6 |
| &nbsp;&nbsp;`CONSUMER_OUTPUT` | 2 |
| &nbsp;&nbsp;`REFERENCE_DATA` | 1 |
| &nbsp;&nbsp;`BOOKKEEPING` | 1 |
| **Distinct event names these functions emit** | **80** |
| &nbsp;&nbsp;already in the catalogue or among the 46 planned | 4 (`ClaimSettled`, `ClaimSubmitted`, `ReconciliationExceptionResolved`, `SpecimenCollected`) |
| &nbsp;&nbsp;**new event names** | **76** (round 1: 155) |

| Step | Module | Functions | Event names (new) |
|---|---|---|---|
| 4 | ADT, scheduling and ED | 18 | 7 (7) |
| 5 | Nursing and tasks (step 5b) | 8 | 4 (4) |
| 6 | Orders, results, medication, pharmacy, ICU, care plans | 33 | 16 (16) |
| 7 | Patient access, consent and record | 10 | 5 (5) |
| 8 | Operating theatre and blood bank | 22 | 10 (9) |
| 9 | Billing, claims and NHCX | 27 | 16 (13) |
| 9a | Inventory and procurement | 27 | 7 (7) |
| 9b | Quality, safety and operations | 27 | 11 (11) |
| 9c | Access, identity, interoperability and workforce | 14 | 7 (7) |

## The new event names

Each name with the functions that emit it. *StatusChanged* events carry `from` / `to`; *Recorded* events carry a type code.

| # | Event | Step | Functions |
|---|---|---|---|
| 1 | `AdmissionRequestStatusChanged` | 4 | `cancelRequest`, `deferRequest`, `rejectRequest`, `releaseReservation` |
| 2 | `AppointmentStatusChanged` | 4 | `confirmAppointment`, `markNoShow` |
| 3 | `PatientLocationChanged` | 4 | `assignEdLocation`, `releaseEdLocation` |
| 4 | `PatientMergeStatusChanged` | 4 | `mergePatients`, `unmergePatients` |
| 5 | `ResuscitationStatusChanged` | 4 | `activateResuscitation`, `updateResuscitation` |
| 6 | `TransferRequestStatusChanged` | 4 | `acceptTransferRequest`, `cancelTransferRequest`, `createTransferRequest`, `markPatientInTransit`, `reserveBedForTransfer` |
| 7 | `ClinicalHandoffStatusChanged` | 5 | `acknowledgeHandoff`, `createHandoff` |
| 8 | `NurseAssignmentStatusChanged` | 5 | `assignNurse`, `endAssignment` |
| 9 | `NursingAssessmentRecorded` | 5 | `amendAssessment`, `completeAssessment`, `signAssessment` |
| 10 | `TaskUpdated` | 5 | `updateTask` |
| 11 | `CarePlanUpdated` | 6 | `closeCarePlan`, `completeIntervention`, `createCarePlan` |
| 12 | `DiagnosticReportAmended` | 6 | `amendReport`, `amendResult` |
| 13 | `ExternalLabReferralStatusChanged` | 6 | `createExternalReferral`, `transitionExternalReferral` |
| 14 | `IcuDeviceStatusChanged` | 6 | `recordDevice`, `updateDeviceStatus` |
| 15 | `IcuInfusionStatusChanged` | 6 | `recordInfusion`, `updateInfusionStatus` |
| 16 | `ImagingStudyStatusChanged` | 6 | `cancelStudy`, `rescheduleStudy`, `scheduleStudy` |
| 17 | `MedicationOrderStatusChanged` | 6 | `cancelMedicationOrder`, `discontinueMedicationOrder`, `holdMedicationOrder`, `rejectMedicationOrder`, `requestClarification`, `resubmitMedicationOrder` |
| 18 | `MedicationRecallStatusChanged` | 6 | `closeRecall`, `createRecall` |
| 19 | `MedicationReconciliationRecorded` | 6 | `recordReconciliation` |
| 20 | `MedicationSafetyWarningOverridden` | 6 | `acknowledgeSafetyWarning` |
| 21 | `MedicationSubstituted` | 6 | `recordSubstitution` |
| 22 | `PharmacyComplianceRecorded` | 6 | `recordControlledWastage`, `recordStorageCheck` |
| 23 | `ProblemListUpdated` | 6 | `addDiagnosisToProblemList` |
| 24 | `SpecimenStatusChanged` | 6 | `recollectSpecimen`, `rejectSpecimen` |
| 25 | `ConsentExpired` | 7 | `expireLapsedConsents` |
| 26 | `ConsentRequestStatusChanged` | 7 | `closeConsentRequest`, `requestConsent` |
| 27 | `PatientAccessSessionStatusChanged` | 7 | `endAccessSession`, `extendAccessSession`, `issueAccessCode`, `redeemAccessCode` |
| 28 | `PatientAccountLinked` | 7 | `verifyLinkOtp` |
| 29 | `PatientDemographicsUpdated` | 7 | `addPatientIdentifier`, `updateProfile` |
| 30 | `BloodCompatibilityRecorded` | 8 | `recordPatientTyping`, `verifyCompatibility` |
| 31 | `BloodRequestStatusChanged` | 8 | `requestBlood`, `transitionRequest` |
| 32 | `BloodUnitStatusChanged` | 8 | `quarantineUnit`, `recallUnit`, `registerBloodUnit`, `releaseReservation`, `releaseUnit`, `reserveUnits`, `returnUnit`, `wasteUnit` |
| 33 | `EmergencyBloodReleaseAuthorized` | 8 | `authorizeEmergencyRelease` |
| 34 | `ObservationRecorded` | 8 | `recordObservation`, `recordReassessment`, `recordTransfusionObservation` |
| 35 | `PerioperativeRecordRecorded` | 8 | `recordAnesthesia`, `updateChecklistItem` |
| 36 | `SurgeryStatusChanged` | 8 | `cancelSchedule`, `transitionSurgery`, `updateRecovery` |
| 37 | `TransfusionReactionStatusChanged` | 8 | `transitionReaction` |
| 38 | `TransfusionStatusChanged` | 8 | `transitionTransfusion` |
| 39 | `BillingAdjustmentStatusChanged` | 9 | `approveAdjustment`, `rejectAdjustment` |
| 40 | `ChargeVoided` | 9 | `voidCharge` |
| 41 | `ClaimQueryStatusChanged` | 9 | `recordQuery`, `respondToQuery`, `transitionQuery` |
| 42 | `ClaimReconciliationStatusChanged` | 9 | `raiseException`, `resolveException` (reconciliation exceptions only; settlements emit the planned `ClaimSettled`) |
| 43 | `ClaimStatusChanged` | 9 | `closeClaim`, `recordClaimDecision` |
| 44 | `CoverageStatusChanged` | 9 | `addPatientCoverage`, `deactivateCoverage` |
| 45 | `CreditStatusChanged` | 9 | `applyCreditToInvoice`, `issueCredit` |
| 46 | `HospitalInvoiceVoided` | 9 | `voidInvoice` |
| 47 | `HospitalPaymentStatusChanged` | 9 | `allocatePayment`, `voidPayment` |
| 48 | `HospitalRefundStatusChanged` | 9 | `completeRefund`, `rejectRefund` |
| 49 | `InvoiceVoided` | 9 | `voidInvoice` |
| 50 | `PreauthStatusChanged` | 9 | `expirePreAuth`, `requestPreAuth` |
| 51 | `SubscriptionStatusChanged` | 9 | `transitionSubscription` |
| 52 | `PurchaseOrderStatusChanged` | 9a | `approvePurchaseOrder`, `cancelPurchaseOrder`, `closePurchaseOrder` |
| 53 | `SerialUnitStatusChanged` | 9a | `registerSerial`, `transitionSerial` |
| 54 | `StockDocumentStatusChanged` | 9a | `approveAdjustment`, `approveWaste`, `completeStockTake`, `rejectAdjustment`, `rejectGoodsReceipt`, `rejectWaste` |
| 55 | `StockLotStatusChanged` | 9a | `quarantineLot`, `quarantinePharmacyLot`, `releaseLotFromQuarantine`, `releasePharmacyQuarantine` |
| 56 | `StockMoved` | 9a | `cancelTransfer`, `classifyMedicationReturn`, `consumeReservation`, `createAdjustment`, `createPharmacyTransfer`, `initiateTransfer`, `receiveTransfer`, `recordWaste`, `releaseReservation`, `reserveStock` |
| 57 | `SupplierInvoiceStatusChanged` | 9a | `recordSupplierInvoice`, `reviewSupplierInvoice` |
| 58 | `SupplyRequestStatusChanged` | 9a | `transitionDepartmentRequest`, `transitionPharmacyRequest` |
| 59 | `CapaStatusChanged` | 9b | `createCapa`, `transitionCapa` |
| 60 | `DietOrderStatusChanged` | 9b | `createDietOrder`, `setDietOrderStatus` |
| 61 | `EquipmentServiceRecorded` | 9b | `completePreventiveMaintenance`, `recordEquipmentCalibration`, `recordEquipmentMaintenance` |
| 62 | `EquipmentStatusChanged` | 9b | `endDowntime`, `setEquipmentStatus`, `startDowntime` |
| 63 | `InfectionExposureRecorded` | 9b | `recordExposure` |
| 64 | `InfectionIncidentStatusChanged` | 9b | `createInfectionIncident`, `createInfectionInvestigation`, `transitionInfectionIncident` |
| 65 | `LabQualityControlRecorded` | 9b | `recordCalibration`, `recordQc`, `reviewCalibration`, `reviewQc` |
| 66 | `MaintenanceRequestStatusChanged` | 9b | `createMaintenanceRequest`, `transitionMaintenance` |
| 67 | `QualityFindingStatusChanged` | 9b | `closeFinding`, `createFinding` |
| 68 | `QualityIncidentStatusChanged` | 9b | `createQualityIncident`, `reopenIncident`, `reviewRca`, `transitionIncident` |
| 69 | `QualityMeasureStatusChanged` | 9b | `setMeasureStatus` |
| 70 | `BreakGlassStatusChanged` | 9c | `activateBreakGlass`, `expireLapsedBreakGlass` |
| 71 | `ExternalIdentifierStatusChanged` | 9c | `linkExternalIdentifier`, `unlinkExternalIdentifier`, `verifyExternalIdentifier` |
| 72 | `HealthInformationExchangeRequested` | 9c | `createExchange` |
| 73 | `ImportedResourceReviewed` | 9c | `reviewImportedResource` |
| 74 | `LegalHoldSet` | 9c | `setLegalHold` |
| 75 | `PrivacyRequestStatusChanged` | 9c | `createPrivacyRequest`, `transitionPrivacyRequest` |
| 76 | `StaffAuthorizationChanged` | 9c | `createAssignment`, `createCredential`, `endAssignment`, `grantPrivilege` |

### Second-pass merges

Beyond the one-per-aggregate rule, to reach the 60–80 target. Each is a judgement; any can be split back out.

| Was (round 1 / first pass) | Now | Why |
|---|---|---|
| `PatientBloodTypeRecorded` | `BloodCompatibilityRecorded` | one Recorded event for blood-compatibility documentation, kind PATIENT_TYPING \| CROSSMATCH_VERIFIED |
| `CrossmatchVerified` | `BloodCompatibilityRecorded` | same |
| `AnesthesiaRecorded` | `PerioperativeRecordRecorded` | one Recorded event for perioperative documentation, kind ANESTHESIA \| SAFETY_CHECKLIST |
| `SurgicalSafetyChecklistRecorded` | `PerioperativeRecordRecorded` | same |
| `RecoveryStatusChanged` | `SurgeryStatusChanged` | recovery is a phase of the surgical case (to = RECOVERY_*) |
| `SurgicalSpecimenCollected` | `SpecimenCollected` | the planned event, with specimenSource = SURGICAL |
| `StorageCheckRecorded` | `PharmacyComplianceRecorded` | one Recorded event for pharmacy compliance documentation, kind STORAGE_CHECK \| CONTROLLED_WASTAGE |
| `ControlledDrugWasted` | `PharmacyComplianceRecorded` | same; the stock movement itself is StockMoved |
| `PatientProfileUpdated` | `PatientDemographicsUpdated` | profile and identifier changes to the same record, with a change kind |
| `PatientIdentifierAdded` | `PatientDemographicsUpdated` | same |
| `ClaimSettlementStatusChanged` | `ClaimSettled` (planned #59) | approved change 1: settlements emit ClaimSettled; the reconciliation event covers only exceptions |
| `ClaimReconciliationExceptionStatusChanged` | `ClaimReconciliationStatusChanged` | same |
| `StockAdjustmentStatusChanged` | `StockDocumentStatusChanged` | one decision event for approval-gated inventory documents; approved on condition that the payload carries the closed code `documentType` = ADJUSTMENT \| WASTE \| GOODS_RECEIPT \| STOCK_TAKE |
| `WasteRecordStatusChanged` | `StockDocumentStatusChanged` | same |
| `GoodsReceiptRejected` | `StockDocumentStatusChanged` | same; approval stays GoodsReceived |
| `StockTakeCompleted` | `StockDocumentStatusChanged` | same; variances post as StockMoved |
| `InfectionInvestigationOpened` | `InfectionIncidentStatusChanged` | opening an investigation moves the incident (to = INVESTIGATING) |
| `RootCauseAnalysisReviewed` | `QualityIncidentStatusChanged` | the RCA review is a stage of the incident |
| `StaffAssignmentChanged` | `StaffAuthorizationChanged` | department assignment, credentials and privileges all decide what a staff member may do; approved on condition that the payload carries `changeType` = DEPARTMENT \| CREDENTIAL \| PRIVILEGE and `subjectStaffId` |
| `StaffCredentialRecorded` | `StaffAuthorizationChanged` | same |
| `LabResultAmended` | `DiagnosticReportAmended` | rag-indexer re-indexes either way; reportKind LAB \| IMAGING |
| `ImagingReportAmended` | `DiagnosticReportAmended` | same |
| `PatientsMerged` | `PatientMergeStatusChanged` | rag-indexer re-keys the patient index either way; action MERGED \| UNMERGED |
| `PatientsUnmerged` | `PatientMergeStatusChanged` | same |

### Kept specific (a listed consumer subscribes to the transition)

- `ConsentExpired`: rag-indexer: stop serving the record exactly as on ConsentRevoked.
- `DiagnosticReportAmended`: rag-indexer: re-index the amended result or report (it subscribes to the releases).
- `PatientMergeStatusChanged`: rag-indexer: the per-patient index is re-keyed on merge and split on unmerge.
- `HospitalInvoiceVoided`: discharge-readiness: billing readiness is recomputed (it subscribes to HospitalInvoiceIssued).
- `StockMoved` stays one event for every ledger movement (`postLedgerEntry`, registered as an emitting helper at 9a); `StockBelowReorder` stays on the cut list.

### Other notes

- **`GoodsReceived` leaves the cut list** and moves to 9a: it is the boundary event that makes recording a goods receipt a process step. A rejection is `StockDocumentStatusChanged` (documentType GOODS_RECEIPT).
- **`SpecimenCollected` (planned) gains a producer:** `surgery.ts#collectSpecimen`, with `specimenSource` = LAB_ORDER | SURGICAL.
- **Waste flow changes at step 9a (approved change 4).** Today `recordWaste` posts the write-off immediately and `rejectWaste` only marks the record REJECTED, so a rejected waste stays written off. At 9a: `recordWaste` moves the quantity to a **HOLD** state (unavailable, not written off) with a ledger entry (`StockMoved`); `approveWaste` posts the write-off from HOLD; `rejectWaste` posts a return from HOLD to available stock (both `StockDocumentStatusChanged`, documentType WASTE, plus `StockMoved`). Ledger entries are never edited: every step is a new entry. Step 9a adds a gate covering record → reject (stock fully restored) and record → approve (stock written off exactly once).
- **Requisitions and RFQs are `OPERATIONAL_DETAIL`, not process steps:** they never commit money or stock, so they have no outcome to emit; money is committed by the purchase order (`PurchaseOrderStatusChanged`). Round 1 had them as process steps.
- **`decideLinkRequest`** counts as emitting through its CREATE_NEW branch; its LINK branch emits `PatientAccountLinked` (FRONT_DESK) since step 7.

## Borderline calls to review

- **Meal delivery** (`transitionMeal`): a REFUSED or MISSED meal is arguably a care fact. Exempted as kitchen logistics; the diet order is an event.
- **Patient transport and ambulance trips:** exempted as logistics; location changes are their own events.
- **Staff shifts and availability:** exempted; they don't change access.
- **Queue tokens:** exempted, consistent with "QueueTokenCalled is not an event".
- **Theatre team roster** (`setTeamMember`): exempted; becomes (c) if team membership should gate access to the case record.
- **Delegate invitations** (`inviteDelegate`): a process step with boundary `FamilyAccessGranted`; a lapsed or declined invitation changes no access, so it emits nothing.

## Mapping: functions that become events

### Step 4: ADT, scheduling and ED (18 functions)

| Function | File | Decision | Event | Note |
|---|---|---|---|---|
| `cancelRequest` | `src/lib/hospital/admissionRequest.ts` | (a) | `AdmissionRequestStatusChanged` |  |
| `deferRequest` | `src/lib/hospital/admissionRequest.ts` | (a) | `AdmissionRequestStatusChanged` |  |
| `rejectRequest` | `src/lib/hospital/admissionRequest.ts` | (a) | `AdmissionRequestStatusChanged` |  |
| `releaseReservation` | `src/lib/hospital/admissionRequest.ts` | (a) | `AdmissionRequestStatusChanged` |  |
| `confirmAppointment` | `src/lib/hospital/appointment.ts` | (a) | `AppointmentStatusChanged` |  |
| `markNoShow` | `src/lib/hospital/appointment.ts` | (a) | `AppointmentStatusChanged` |  |
| `recordReassessment` | `src/lib/hospital/emergency.ts` | (a) | `ObservationRecorded` |  |
| `assignEdLocation` | `src/lib/hospital/emergency.ts` | (a) | `PatientLocationChanged` | EncounterLocation is the location history (D5) |
| `releaseEdLocation` | `src/lib/hospital/emergency.ts` | (a) | `PatientLocationChanged` |  |
| `mergePatients` | `src/lib/patient/merge.ts` | (a) | `PatientMergeStatusChanged` |  |
| `unmergePatients` | `src/lib/patient/merge.ts` | (a) | `PatientMergeStatusChanged` |  |
| `activateResuscitation` | `src/lib/hospital/emergency.ts` | (a) | `ResuscitationStatusChanged` |  |
| `updateResuscitation` | `src/lib/hospital/emergency.ts` | (a) | `ResuscitationStatusChanged` |  |
| `acceptTransferRequest` | `src/lib/hospital/transferRequest.ts` | (a) | `TransferRequestStatusChanged` |  |
| `cancelTransferRequest` | `src/lib/hospital/transferRequest.ts` | (a) | `TransferRequestStatusChanged` |  |
| `createTransferRequest` | `src/lib/hospital/transferRequest.ts` | (a) | `TransferRequestStatusChanged` |  |
| `markPatientInTransit` | `src/lib/hospital/transferRequest.ts` | (a) | `TransferRequestStatusChanged` |  |
| `reserveBedForTransfer` | `src/lib/hospital/transferRequest.ts` | (a) | `TransferRequestStatusChanged` |  |

### Step 5: Nursing and tasks (step 5b) (8 functions)

| Function | File | Decision | Event | Note |
|---|---|---|---|---|
| `acknowledgeHandoff` | `src/lib/hospital/handoff.ts` | (a) | `ClinicalHandoffStatusChanged` |  |
| `createHandoff` | `src/lib/hospital/handoff.ts` | (a) | `ClinicalHandoffStatusChanged` | transfers responsibility for the patient |
| `assignNurse` | `src/lib/hospital/nursingAssignment.ts` | (a) | `NurseAssignmentStatusChanged` |  |
| `endAssignment` | `src/lib/hospital/nursingAssignment.ts` | (a) | `NurseAssignmentStatusChanged` |  |
| `amendAssessment` | `src/lib/hospital/nursingAssessment.ts` | (a) | `NursingAssessmentRecorded` | amendment carries supersedesAssessmentId, like notes |
| `completeAssessment` | `src/lib/hospital/nursingAssessment.ts` | (a) | `NursingAssessmentRecorded` |  |
| `signAssessment` | `src/lib/hospital/nursingAssessment.ts` | (a) | `NursingAssessmentRecorded` |  |
| `updateTask` | `src/lib/hospital/task.ts` | (a) | `TaskUpdated` |  |

### Step 6: Orders, results, medication, pharmacy, ICU, care plans (33 functions)

| Function | File | Decision | Event | Note |
|---|---|---|---|---|
| `closeCarePlan` | `src/lib/hospital/carePlan.ts` | (a) | `CarePlanUpdated` |  |
| `completeIntervention` | `src/lib/hospital/carePlan.ts` | (a) | `CarePlanUpdated` |  |
| `createCarePlan` | `src/lib/hospital/carePlan.ts` | (a) | `CarePlanUpdated` |  |
| `amendReport` | `src/lib/hospital/imagingReportLifecycle.ts` | (a) | `DiagnosticReportAmended` |  |
| `amendResult` | `src/lib/hospital/labResultLifecycle.ts` | (a) | `DiagnosticReportAmended` |  |
| `createExternalReferral` | `src/lib/hospital/diagnosticsAdvanced.ts` | (a) | `ExternalLabReferralStatusChanged` |  |
| `transitionExternalReferral` | `src/lib/hospital/diagnosticsAdvanced.ts` | (a) | `ExternalLabReferralStatusChanged` |  |
| `recordDevice` | `src/lib/hospital/icu.ts` | (a) | `IcuDeviceStatusChanged` |  |
| `updateDeviceStatus` | `src/lib/hospital/icu.ts` | (a) | `IcuDeviceStatusChanged` |  |
| `recordInfusion` | `src/lib/hospital/icu.ts` | (a) | `IcuInfusionStatusChanged` |  |
| `updateInfusionStatus` | `src/lib/hospital/icu.ts` | (a) | `IcuInfusionStatusChanged` |  |
| `cancelStudy` | `src/lib/hospital/imagingStudyLifecycle.ts` | (a) | `ImagingStudyStatusChanged` |  |
| `rescheduleStudy` | `src/lib/hospital/imagingStudyLifecycle.ts` | (a) | `ImagingStudyStatusChanged` |  |
| `scheduleStudy` | `src/lib/hospital/imagingStudyLifecycle.ts` | (a) | `ImagingStudyStatusChanged` |  |
| `cancelMedicationOrder` | `src/lib/hospital/medicationLifecycle.ts` | (a) | `MedicationOrderStatusChanged` |  |
| `discontinueMedicationOrder` | `src/lib/hospital/medicationLifecycle.ts` | (a) | `MedicationOrderStatusChanged` |  |
| `holdMedicationOrder` | `src/lib/hospital/medicationLifecycle.ts` | (a) | `MedicationOrderStatusChanged` |  |
| `rejectMedicationOrder` | `src/lib/hospital/medicationLifecycle.ts` | (a) | `MedicationOrderStatusChanged` |  |
| `requestClarification` | `src/lib/hospital/medicationLifecycle.ts` | (a) | `MedicationOrderStatusChanged` |  |
| `resubmitMedicationOrder` | `src/lib/hospital/medicationLifecycle.ts` | (a) | `MedicationOrderStatusChanged` |  |
| `closeRecall` | `src/lib/hospital/pharmacy.ts` | (d) | `MedicationRecallStatusChanged` |  |
| `createRecall` | `src/lib/hospital/pharmacy.ts` | (d) | `MedicationRecallStatusChanged` |  |
| `recordReconciliation` | `src/lib/hospital/reconciliation.ts` | (a) | `MedicationReconciliationRecorded` |  |
| `acknowledgeSafetyWarning` | `src/lib/hospital/medicationLifecycle.ts` | (d) | `MedicationSafetyWarningOverridden` |  |
| `recordSubstitution` | `src/lib/hospital/pharmacy.ts` | (a) | `MedicationSubstituted` |  |
| `recordObservation` | `src/lib/hospital/icu.ts` | (a) | `ObservationRecorded` | one event type for point-of-care observations, with an observation-kind code |
| `recordControlledWastage` | `src/lib/hospital/pharmacy.ts` | (d) | `PharmacyComplianceRecorded` | regulatory fact; the stock movement is StockMoved |
| `recordStorageCheck` | `src/lib/hospital/pharmacy.ts` | (d) | `PharmacyComplianceRecorded` | an EXCURSION is the safety fact |
| `addDiagnosisToProblemList` | `src/lib/hospital/problemList.ts` | (a) | `ProblemListUpdated` |  |
| `recollectSpecimen` | `src/lib/hospital/specimenLifecycle.ts` | (a) | `SpecimenStatusChanged` |  |
| `rejectSpecimen` | `src/lib/hospital/specimenLifecycle.ts` | (a) | `SpecimenStatusChanged` | the patient must be re-sampled |
| `quarantinePharmacyLot` | `src/lib/hospital/pharmacy.ts` | (d) | `StockLotStatusChanged` |  |
| `releasePharmacyQuarantine` | `src/lib/hospital/pharmacy.ts` | (d) | `StockLotStatusChanged` |  |

### Step 7: Patient access, consent and record (10 functions)

| Function | File | Decision | Event | Note |
|---|---|---|---|---|
| `expireLapsedConsents` | `src/lib/consent/lifecycle.ts` | (c) | `ConsentExpired` |  |
| `closeConsentRequest` | `src/lib/consent/lifecycle.ts` | (c) | `ConsentRequestStatusChanged` |  |
| `requestConsent` | `src/lib/consent/lifecycle.ts` | (c) | `ConsentRequestStatusChanged` |  |
| `endAccessSession` | `src/lib/patient/accessSession.ts` | (c) | `PatientAccessSessionStatusChanged` |  |
| `extendAccessSession` | `src/lib/patient/accessSession.ts` | (c) | `PatientAccessSessionStatusChanged` |  |
| `issueAccessCode` | `src/lib/patient/accessSession.ts` | (c) | `PatientAccessSessionStatusChanged` |  |
| `redeemAccessCode` | `src/lib/patient/accessSession.ts` | (c) | `PatientAccessSessionStatusChanged` |  |
| `verifyLinkOtp` | `src/lib/patient/selfRegistration.ts` | (c) | `PatientAccountLinked` | links a portal account to a record |
| `updateProfile` | `src/lib/patient/experience/profile.ts` | (a) | `PatientDemographicsUpdated` |  |
| `addPatientIdentifier` | `src/lib/patient/identifiers.ts` | (a) | `PatientDemographicsUpdated` |  |

### Step 8: Operating theatre and blood bank (22 functions)

| Function | File | Decision | Event | Note |
|---|---|---|---|---|
| `recordPatientTyping` | `src/lib/hospital/blood.ts` | (a) | `BloodCompatibilityRecorded` |  |
| `verifyCompatibility` | `src/lib/hospital/blood.ts` | (a) | `BloodCompatibilityRecorded` |  |
| `requestBlood` | `src/lib/hospital/blood.ts` | (a) | `BloodRequestStatusChanged` |  |
| `transitionRequest` | `src/lib/hospital/blood.ts` | (a) | `BloodRequestStatusChanged` |  |
| `quarantineUnit` | `src/lib/hospital/blood.ts` | (d) | `BloodUnitStatusChanged` |  |
| `recallUnit` | `src/lib/hospital/blood.ts` | (d) | `BloodUnitStatusChanged` |  |
| `registerBloodUnit` | `src/lib/hospital/blood.ts` | (b) | `BloodUnitStatusChanged` |  |
| `releaseReservation` | `src/lib/hospital/blood.ts` | (b) | `BloodUnitStatusChanged` |  |
| `releaseUnit` | `src/lib/hospital/blood.ts` | (b) | `BloodUnitStatusChanged` |  |
| `reserveUnits` | `src/lib/hospital/blood.ts` | (b) | `BloodUnitStatusChanged` |  |
| `returnUnit` | `src/lib/hospital/blood.ts` | (b) | `BloodUnitStatusChanged` |  |
| `wasteUnit` | `src/lib/hospital/blood.ts` | (b) | `BloodUnitStatusChanged` |  |
| `authorizeEmergencyRelease` | `src/lib/hospital/blood.ts` | (d) | `EmergencyBloodReleaseAuthorized` |  |
| `recordTransfusionObservation` | `src/lib/hospital/blood.ts` | (a) | `ObservationRecorded` |  |
| `recordAnesthesia` | `src/lib/hospital/surgery.ts` | (a) | `PerioperativeRecordRecorded` |  |
| `updateChecklistItem` | `src/lib/hospital/surgery.ts` | (d) | `PerioperativeRecordRecorded` |  |
| `collectSpecimen` | `src/lib/hospital/surgery.ts` | (a) | `SpecimenCollected` |  |
| `cancelSchedule` | `src/lib/hospital/surgery.ts` | (a) | `SurgeryStatusChanged` |  |
| `transitionSurgery` | `src/lib/hospital/surgery.ts` | (a) | `SurgeryStatusChanged` |  |
| `updateRecovery` | `src/lib/hospital/surgery.ts` | (a) | `SurgeryStatusChanged` |  |
| `transitionReaction` | `src/lib/hospital/blood.ts` | (d) | `TransfusionReactionStatusChanged` |  |
| `transitionTransfusion` | `src/lib/hospital/blood.ts` | (a) | `TransfusionStatusChanged` |  |

### Step 9: Billing, claims and NHCX (27 functions)

| Function | File | Decision | Event | Note |
|---|---|---|---|---|
| `approveAdjustment` | `src/lib/hospital/billing/adjustments.ts` | (b) | `BillingAdjustmentStatusChanged` |  |
| `rejectAdjustment` | `src/lib/hospital/billing/adjustments.ts` | (b) | `BillingAdjustmentStatusChanged` | a rejection is the process outcome |
| `voidCharge` | `src/lib/hospital/billing/chargeCapture.ts` | (b) | `ChargeVoided` |  |
| `recordQuery` | `src/lib/hospital/nhcx/queries.ts` | (b) | `ClaimQueryStatusChanged` |  |
| `respondToQuery` | `src/lib/hospital/nhcx/queries.ts` | (b) | `ClaimQueryStatusChanged` |  |
| `transitionQuery` | `src/lib/hospital/nhcx/queries.ts` | (b) | `ClaimQueryStatusChanged` |  |
| `raiseException` | `src/lib/hospital/nhcx/reconciliation.ts` | (b) | `ClaimReconciliationStatusChanged` |  |
| `reconcileSettlement` | `src/lib/hospital/nhcx/reconciliation.ts` | (b) | `ClaimSettled` | approved change 1: a settlement emits ClaimSettled (stage RECONCILED) |
| `recordSettlement` | `src/lib/hospital/nhcx/reconciliation.ts` | (b) | `ClaimSettled` | approved change 1: a settlement emits ClaimSettled (stage NOTIFIED) |
| `resolveException` | `src/lib/hospital/nhcx/reconciliation.ts` | (b) | `ClaimReconciliationStatusChanged` |  |
| `closeClaim` | `src/lib/hospital/billing/claims.ts` | (b) | `ClaimStatusChanged` |  |
| `recordClaimDecision` | `src/lib/hospital/billing/claims.ts` | (b) | `ClaimStatusChanged` |  |
| `submitClaim` | `src/lib/hospital/billing/claims.ts` | (b) | `ClaimSubmitted` | the non-NHCX submission path |
| `addPatientCoverage` | `src/lib/hospital/billing/coverage.ts` | (b) | `CoverageStatusChanged` |  |
| `deactivateCoverage` | `src/lib/hospital/billing/coverage.ts` | (b) | `CoverageStatusChanged` |  |
| `applyCreditToInvoice` | `src/lib/billing/credits.ts` | (b) | `CreditStatusChanged` |  |
| `issueCredit` | `src/lib/billing/credits.ts` | (b) | `CreditStatusChanged` |  |
| `voidInvoice` | `src/lib/hospital/billing/invoices.ts` | (b) | `HospitalInvoiceVoided` |  |
| `allocatePayment` | `src/lib/hospital/billing/payments.ts` | (b) | `HospitalPaymentStatusChanged` |  |
| `voidPayment` | `src/lib/hospital/billing/payments.ts` | (b) | `HospitalPaymentStatusChanged` |  |
| `completeRefund` | `src/lib/hospital/billing/refunds.ts` | (b) | `HospitalRefundStatusChanged` |  |
| `rejectRefund` | `src/lib/hospital/billing/refunds.ts` | (b) | `HospitalRefundStatusChanged` | a rejection is the process outcome |
| `voidInvoice` | `src/lib/billing/invoices.ts` | (b) | `InvoiceVoided` |  |
| `expirePreAuth` | `src/lib/hospital/billing/preauth.ts` | (b) | `PreauthStatusChanged` |  |
| `requestPreAuth` | `src/lib/hospital/billing/preauth.ts` | (b) | `PreauthStatusChanged` |  |
| `resolveException` | `src/lib/billing/reconciliation.ts` | (b) | `ReconciliationExceptionResolved` | the existing event, from this second path |
| `transitionSubscription` | `src/lib/commercial/subscriptions.ts` | (c) | `SubscriptionStatusChanged` | entitlements follow the subscription |

### Step 9a: Inventory and procurement (27 functions)

| Function | File | Decision | Event | Note |
|---|---|---|---|---|
| `approvePurchaseOrder` | `src/lib/hospital/procurement/purchaseOrders.ts` | (b) | `PurchaseOrderStatusChanged` | commits money to a supplier |
| `cancelPurchaseOrder` | `src/lib/hospital/procurement/purchaseOrders.ts` | (b) | `PurchaseOrderStatusChanged` |  |
| `closePurchaseOrder` | `src/lib/hospital/procurement/purchaseOrders.ts` | (b) | `PurchaseOrderStatusChanged` |  |
| `registerSerial` | `src/lib/hospital/inventory/inventoryAdvanced.ts` | (b) | `SerialUnitStatusChanged` |  |
| `transitionSerial` | `src/lib/hospital/inventory/inventoryAdvanced.ts` | (b) | `SerialUnitStatusChanged` |  |
| `approveAdjustment` | `src/lib/hospital/inventory/adjustment.ts` | (b) | `StockDocumentStatusChanged` | plus StockMoved from postLedgerEntry |
| `rejectAdjustment` | `src/lib/hospital/inventory/adjustment.ts` | (b) | `StockDocumentStatusChanged` | a rejection is the process outcome |
| `completeStockTake` | `src/lib/hospital/inventory/stocktake.ts` | (b) | `StockDocumentStatusChanged` | variances post as StockMoved |
| `approveWaste` | `src/lib/hospital/inventory/waste.ts` | (b) | `StockDocumentStatusChanged` | at 9a: posts the write-off from HOLD (approved change 4) |
| `rejectWaste` | `src/lib/hospital/inventory/waste.ts` | (b) | `StockDocumentStatusChanged` | at 9a: posts a return from HOLD to available stock (approved change 4) |
| `rejectGoodsReceipt` | `src/lib/hospital/procurement/goodsReceipts.ts` | (b) | `StockDocumentStatusChanged` | approval is GoodsReceived (planned) |
| `quarantineLot` | `src/lib/hospital/inventory/lots.ts` | (d) | `StockLotStatusChanged` |  |
| `releaseLotFromQuarantine` | `src/lib/hospital/inventory/lots.ts` | (d) | `StockLotStatusChanged` |  |
| `createAdjustment` | `src/lib/hospital/inventory/adjustment.ts` | (b) | `StockMoved` | via postLedgerEntry |
| `consumeReservation` | `src/lib/hospital/inventory/reservation.ts` | (b) | `StockMoved` | via postLedgerEntry |
| `releaseReservation` | `src/lib/hospital/inventory/reservation.ts` | (b) | `StockMoved` | via postLedgerEntry |
| `reserveStock` | `src/lib/hospital/inventory/reservation.ts` | (b) | `StockMoved` | via postLedgerEntry |
| `cancelTransfer` | `src/lib/hospital/inventory/transfer.ts` | (b) | `StockMoved` | via postLedgerEntry |
| `initiateTransfer` | `src/lib/hospital/inventory/transfer.ts` | (b) | `StockMoved` | via postLedgerEntry |
| `receiveTransfer` | `src/lib/hospital/inventory/transfer.ts` | (b) | `StockMoved` | via postLedgerEntry |
| `recordWaste` | `src/lib/hospital/inventory/waste.ts` | (b) | `StockMoved` | at 9a: moves the quantity to HOLD (unavailable, not written off) via postLedgerEntry |
| `classifyMedicationReturn` | `src/lib/hospital/pharmacy.ts` | (b) | `StockMoved` | via postLedgerEntry |
| `createPharmacyTransfer` | `src/lib/hospital/pharmacy.ts` | (b) | `StockMoved` | via initiateTransfer |
| `recordSupplierInvoice` | `src/lib/hospital/procurement/procurementAdvanced.ts` | (b) | `SupplierInvoiceStatusChanged` |  |
| `reviewSupplierInvoice` | `src/lib/hospital/procurement/procurementAdvanced.ts` | (b) | `SupplierInvoiceStatusChanged` |  |
| `transitionDepartmentRequest` | `src/lib/hospital/inventory/inventoryAdvanced.ts` | (b) | `SupplyRequestStatusChanged` | plus StockMoved via issueStock / reserveStock when stock moves |
| `transitionPharmacyRequest` | `src/lib/hospital/pharmacy.ts` | (b) | `SupplyRequestStatusChanged` | plus StockMoved via reserveStock / issueStock when stock moves |

### Step 9b: Quality, safety and operations (27 functions)

| Function | File | Decision | Event | Note |
|---|---|---|---|---|
| `createCapa` | `src/lib/hospital/quality/service.ts` | (d) | `CapaStatusChanged` |  |
| `transitionCapa` | `src/lib/hospital/quality/service.ts` | (d) | `CapaStatusChanged` |  |
| `createDietOrder` | `src/lib/hospital/operations/service.ts` | (a) | `DietOrderStatusChanged` |  |
| `setDietOrderStatus` | `src/lib/hospital/operations/service.ts` | (a) | `DietOrderStatusChanged` |  |
| `completePreventiveMaintenance` | `src/lib/hospital/operations/service.ts` | (d) | `EquipmentServiceRecorded` |  |
| `recordEquipmentCalibration` | `src/lib/hospital/operations/service.ts` | (d) | `EquipmentServiceRecorded` |  |
| `recordEquipmentMaintenance` | `src/lib/hospital/operations/service.ts` | (d) | `EquipmentServiceRecorded` |  |
| `endDowntime` | `src/lib/hospital/operations/service.ts` | (d) | `EquipmentStatusChanged` |  |
| `setEquipmentStatus` | `src/lib/hospital/operations/service.ts` | (d) | `EquipmentStatusChanged` |  |
| `startDowntime` | `src/lib/hospital/operations/service.ts` | (d) | `EquipmentStatusChanged` |  |
| `recordExposure` | `src/lib/hospital/operations/service.ts` | (d) | `InfectionExposureRecorded` |  |
| `createInfectionIncident` | `src/lib/hospital/operations/service.ts` | (d) | `InfectionIncidentStatusChanged` |  |
| `createInfectionInvestigation` | `src/lib/hospital/operations/service.ts` | (d) | `InfectionIncidentStatusChanged` |  |
| `transitionInfectionIncident` | `src/lib/hospital/operations/service.ts` | (d) | `InfectionIncidentStatusChanged` |  |
| `recordCalibration` | `src/lib/hospital/diagnosticsAdvanced.ts` | (d) | `LabQualityControlRecorded` |  |
| `recordQc` | `src/lib/hospital/diagnosticsAdvanced.ts` | (d) | `LabQualityControlRecorded` | payload carries the outcome; a failure is the quality fact |
| `reviewCalibration` | `src/lib/hospital/diagnosticsAdvanced.ts` | (d) | `LabQualityControlRecorded` |  |
| `reviewQc` | `src/lib/hospital/diagnosticsAdvanced.ts` | (d) | `LabQualityControlRecorded` |  |
| `createMaintenanceRequest` | `src/lib/hospital/operations/service.ts` | (d) | `MaintenanceRequestStatusChanged` | an equipment or facility fault |
| `transitionMaintenance` | `src/lib/hospital/operations/service.ts` | (d) | `MaintenanceRequestStatusChanged` |  |
| `closeFinding` | `src/lib/hospital/quality/service.ts` | (d) | `QualityFindingStatusChanged` |  |
| `createFinding` | `src/lib/hospital/quality/service.ts` | (d) | `QualityFindingStatusChanged` |  |
| `createQualityIncident` | `src/lib/hospital/quality/service.ts` | (d) | `QualityIncidentStatusChanged` |  |
| `reopenIncident` | `src/lib/hospital/quality/service.ts` | (d) | `QualityIncidentStatusChanged` |  |
| `reviewRca` | `src/lib/hospital/quality/service.ts` | (d) | `QualityIncidentStatusChanged` |  |
| `transitionIncident` | `src/lib/hospital/quality/service.ts` | (d) | `QualityIncidentStatusChanged` |  |
| `setMeasureStatus` | `src/lib/hospital/quality/service.ts` | (d) | `QualityMeasureStatusChanged` |  |

### Step 9c: Access, identity, interoperability and workforce (14 functions)

| Function | File | Decision | Event | Note |
|---|---|---|---|---|
| `activateBreakGlass` | `src/lib/auth/authorize/breakGlass.ts` | (c) | `BreakGlassStatusChanged` |  |
| `expireLapsedBreakGlass` | `src/lib/auth/authorize/breakGlass.ts` | (c) | `BreakGlassStatusChanged` |  |
| `linkExternalIdentifier` | `src/lib/hospital/interoperability/externalIdentity.ts` | (a) | `ExternalIdentifierStatusChanged` |  |
| `unlinkExternalIdentifier` | `src/lib/hospital/interoperability/externalIdentity.ts` | (a) | `ExternalIdentifierStatusChanged` |  |
| `verifyExternalIdentifier` | `src/lib/hospital/interoperability/externalIdentity.ts` | (a) | `ExternalIdentifierStatusChanged` |  |
| `createExchange` | `src/lib/hospital/interoperability/exchange.ts` | (c) | `HealthInformationExchangeRequested` | a disclosure of the record to another party |
| `reviewImportedResource` | `src/lib/hospital/interoperability/fhir/import.ts` | (a) | `ImportedResourceReviewed` | accepted imports enter the record |
| `setLegalHold` | `src/lib/auth/authorize/privacy.ts` | (a) | `LegalHoldSet` | changes how the record may be erased |
| `createPrivacyRequest` | `src/lib/auth/authorize/privacy.ts` | (a) | `PrivacyRequestStatusChanged` | a DPDP data-subject request about the patient's record |
| `transitionPrivacyRequest` | `src/lib/auth/authorize/privacy.ts` | (a) | `PrivacyRequestStatusChanged` |  |
| `createAssignment` | `src/lib/hospital/workforce/service.ts` | (c) | `StaffAuthorizationChanged` | department assignment scopes what staff can act on |
| `createCredential` | `src/lib/hospital/workforce/service.ts` | (c) | `StaffAuthorizationChanged` | credentials gate prescribing and sign-off |
| `endAssignment` | `src/lib/hospital/workforce/service.ts` | (c) | `StaffAuthorizationChanged` |  |
| `grantPrivilege` | `src/lib/hospital/workforce/service.ts` | (c) | `StaffAuthorizationChanged` |  |

## Mapping: named exemptions

### `OPERATIONAL_DETAIL` (46)

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
| `createRfq` | `src/lib/hospital/procurement/procurementAdvanced.ts` | sourcing; money is committed by the purchase order (PurchaseOrderStatusChanged) |
| `recordQuotation` | `src/lib/hospital/procurement/procurementAdvanced.ts` | sourcing; money is committed by the purchase order |
| `selectQuotation` | `src/lib/hospital/procurement/procurementAdvanced.ts` | sourcing; money is committed by the purchase order |
| `transitionRfq` | `src/lib/hospital/procurement/procurementAdvanced.ts` | sourcing; money is committed by the purchase order |
| `addRequisitionLine` | `src/lib/hospital/procurement/requisitions.ts` | internal requisition |
| `approveRequisition` | `src/lib/hospital/procurement/requisitions.ts` | internal requisition; it becomes a purchase order |
| `cancelRequisition` | `src/lib/hospital/procurement/requisitions.ts` | internal requisition; no money, stock or care changes |
| `createRequisitionDraft` | `src/lib/hospital/procurement/requisitions.ts` | internal requisition; money is committed by the purchase order |
| `rejectRequisition` | `src/lib/hospital/procurement/requisitions.ts` | internal requisition; no money, stock or care changes |
| `reviseApprovedRequisition` | `src/lib/hospital/procurement/requisitions.ts` | internal requisition |
| `submitRequisition` | `src/lib/hospital/procurement/requisitions.ts` | internal requisition |
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

### `PROCESS_STEP` (30)

| Function | File | Boundary event | Reason |
|---|---|---|---|
| `addInvoiceLine` | `src/lib/billing/invoices.ts` | `InvoiceFinalized / InvoiceVoided` | edit to a draft invoice; money moves on InvoiceFinalized |
| `createPaymentAttempt` | `src/lib/billing/payments.ts` | `PaymentReceived / PaymentFailed` | an attempt; its outcome is PaymentReceived / PaymentFailed |
| `createAdjustment` | `src/lib/hospital/billing/adjustments.ts` | `BillingAdjustmentStatusChanged` — approved or rejected | adjustment request awaiting approval |
| `addChargeToInvoice` | `src/lib/hospital/billing/invoices.ts` | `HospitalInvoiceIssued / HospitalInvoiceVoided` | edit to a draft invoice |
| `draftInvoiceForAccount` | `src/lib/hospital/billing/invoices.ts` | `HospitalInvoiceIssued / HospitalInvoiceVoided` | draft invoice; money moves on HospitalInvoiceIssued |
| `approveRefund` | `src/lib/hospital/billing/refunds.ts` | `HospitalRefundStatusChanged` — completed or rejected | approval step; money moves on completion |
| `requestRefund` | `src/lib/hospital/billing/refunds.ts` | `HospitalRefundStatusChanged` — completed or rejected | refund request; money moves on completion |
| `recordCompatibility` | `src/lib/hospital/blood.ts` | `BloodCompatibilityRecorded` — compatible or not | crossmatch entry; verification is the event |
| `recordUnitTyping` | `src/lib/hospital/blood.ts` | `BloodUnitStatusChanged` — released or quarantined | lab check on a unit; releasing the unit is the event |
| `recordStudyAcquisition` | `src/lib/hospital/diagnosticsAdvanced.ts` | `ImagingStudyCompleted` | acquisition metadata; ImagingStudyCompleted is the event |
| `setSpecimenIdentity` | `src/lib/hospital/diagnosticsAdvanced.ts` | `SpecimenCollected` | labelling check inside collection; SpecimenCollected is the event |
| `enterReport` | `src/lib/hospital/imagingReportLifecycle.ts` | `ImagingReportReleased` | unverified report; ImagingReportReleased is the event |
| `importFhirPayload` | `src/lib/hospital/interoperability/fhir/import.ts` | `ImportedResourceReviewed` — accept or reject is the outcome | stages inbound resources for review; the record changes only when one is accepted (ImportedResourceReviewed) |
| `createDepartmentRequest` | `src/lib/hospital/inventory/inventoryAdvanced.ts` | `SupplyRequestStatusChanged` — fulfilled, rejected or cancelled | department request; stock moves when it is fulfilled |
| `addStockTakeLine` | `src/lib/hospital/inventory/stocktake.ts` | `StockDocumentStatusChanged` | count in progress |
| `startStockTake` | `src/lib/hospital/inventory/stocktake.ts` | `StockDocumentStatusChanged` — variances post as StockMoved | count in progress; variances move stock on completion |
| `enterResult` | `src/lib/hospital/labResultLifecycle.ts` | `LabResultReleased` | unverified entry; LabResultReleased is the event |
| `buildSubmission` | `src/lib/hospital/nhcx/submission.ts` | `ClaimSubmitted` | builds the package; ClaimSubmitted is the event |
| `createAssessment` | `src/lib/hospital/nursingAssessment.ts` | `NursingAssessmentRecorded` — completion/sign-off is the outcome | draft; the record changes when it is completed or signed |
| `createMedicationReturn` | `src/lib/hospital/pharmacy.ts` | `StockMoved` — classification posts the return or the discard | a return awaiting classification; stock moves on classification |
| `createPharmacyRequest` | `src/lib/hospital/pharmacy.ts` | `SupplyRequestStatusChanged` — fulfilled, rejected or cancelled | ward request; stock moves when it is fulfilled |
| `recordGoodsReceipt` | `src/lib/hospital/procurement/goodsReceipts.ts` | `GoodsReceived / StockDocumentStatusChanged` — GoodsReceived leaves the cut list for this | receipt awaiting approval; GoodsReceived on approval |
| `addPurchaseOrderLine` | `src/lib/hospital/procurement/purchaseOrders.ts` | `PurchaseOrderStatusChanged` | line on a draft purchase order; money is committed on approval |
| `createPurchaseOrderDraft` | `src/lib/hospital/procurement/purchaseOrders.ts` | `PurchaseOrderStatusChanged` — approved, cancelled or closed | draft purchase order; money is committed on approval |
| `markSent` | `src/lib/hospital/procurement/purchaseOrders.ts` | `PurchaseOrderStatusChanged` — closed or cancelled | PO dispatch step |
| `submitForApproval` | `src/lib/hospital/procurement/purchaseOrders.ts` | `PurchaseOrderStatusChanged` — the approval decision | PO approval step |
| `createRca` | `src/lib/hospital/quality/service.ts` | `QualityIncidentStatusChanged` | root-cause analysis draft |
| `updateRca` | `src/lib/hospital/quality/service.ts` | `QualityIncidentStatusChanged` | root-cause analysis draft |
| `acceptSpecimen` | `src/lib/hospital/specimenLifecycle.ts` | `LabResultReleased / SpecimenStatusChanged` — a received specimen ends in a result or a rejection | lab receipt step between collection and result |
| `inviteDelegate` | `src/lib/patient/experience/family.ts` | `FamilyAccessGranted` — an invitation that lapses or is declined changes no access | an invitation grants nothing; access starts on acceptance (FamilyAccessGranted) |

### `INTEGRATION_PROTOCOL` (6)

| Function | File | Reason |
|---|---|---|
| `setProviderCustomerRef` | `src/lib/billing/billingAccount.ts` | payment-provider customer reference |
| `syncProviderCustomer` | `src/lib/billing/billingAccount.ts` | payment-provider customer sync |
| `receiveCallback` | `src/lib/hospital/interoperability/abdm/callbacks.ts` | inbound ABDM callback log; the state changes it causes emit their own events |
| `receiveCallback` | `src/lib/hospital/nhcx/callbacks.ts` | inbound NHCX callback log; the changes it causes emit their own events |
| `retryExchange` | `src/lib/hospital/nhcx/submission.ts` | protocol retry of an exchange |
| `transitionExchange` | `src/lib/hospital/nhcx/submission.ts` | protocol state of an exchange; the claim's status change is its own event |

### `CONSUMER_OUTPUT` (2)

| Function | File | Reason |
|---|---|---|
| `updateDischargeReadiness` | `src/lib/hospital/admission.ts` | written by the discharge-readiness consumer; readiness is derived from events |
| `generateAdministrationSchedule` | `src/lib/hospital/medicationSchedule.ts` | becomes the mar-scheduler consumer's write (reacting to MedicationVerified) |

### `REFERENCE_DATA` (1)

| Function | File | Reason |
|---|---|---|
| `createEquipment` | `src/lib/hospital/operations/service.ts` | equipment register entry |

### `BOOKKEEPING` (1)

| Function | File | Reason |
|---|---|---|
| `accessionSpecimen` | `src/lib/hospital/specimenLifecycle.ts` | runs inside placeLabOrder's transaction; LabOrderPlaced covers it |

## Round 3 (batch 4): writers found by the extended rule

The emit rule now follows private (non-exported) helpers in the same file, at
any depth, for writes and emits (registered helpers across files, as before).
It found 17 exported functions whose writes were inside a private helper. Same
four rules:

| Function | File | Decision | Event / category | Note |
|---|---|---|---|---|
| `checkInStudy` | `src/lib/hospital/imagingStudyLifecycle.ts` | (a) | `ImagingStudyStatusChanged` v2 | **wired** (SCHEDULED → ARRIVED) |
| `startStudy` | `src/lib/hospital/imagingStudyLifecycle.ts` | (a) | `ImagingStudyStatusChanged` v2 | **wired** (ARRIVED → IN_PROGRESS) |
| `receiveSpecimen` | `src/lib/hospital/specimenLifecycle.ts` | (a) | `SpecimenStatusChanged` v2 | **wired** (COLLECTED → RECEIVED) |
| `completeBreakGlass` | `src/lib/auth/authorize/breakGlass.ts` | (c) | `BreakGlassStatusChanged` | 9c |
| `revokeBreakGlass` | `src/lib/auth/authorize/breakGlass.ts` | (c) | `BreakGlassStatusChanged` | 9c |
| `verifyCredential` | `src/lib/hospital/workforce/service.ts` | (c) | `StaffAuthorizationChanged` | 9c, changeType CREDENTIAL |
| `suspendCredential` | `src/lib/hospital/workforce/service.ts` | (c) | `StaffAuthorizationChanged` | 9c, CREDENTIAL |
| `revokeCredential` | `src/lib/hospital/workforce/service.ts` | (c) | `StaffAuthorizationChanged` | 9c, CREDENTIAL |
| `suspendPrivilege` | `src/lib/hospital/workforce/service.ts` | (c) | `StaffAuthorizationChanged` | 9c, PRIVILEGE |
| `reinstatePrivilege` | `src/lib/hospital/workforce/service.ts` | (c) | `StaffAuthorizationChanged` | 9c, PRIVILEGE |
| `revokePrivilege` | `src/lib/hospital/workforce/service.ts` | (c) | `StaffAuthorizationChanged` | 9c, PRIVILEGE |
| `authorizeExchange` | `src/lib/hospital/interoperability/exchange.ts` | (c) | `HealthInformationExchangeStatusChanged` (new name) | 9c; a disclosure of the record |
| `rejectExchange` | `src/lib/hospital/interoperability/exchange.ts` | (c) | `HealthInformationExchangeStatusChanged` | 9c |
| `cancelExchange` | `src/lib/hospital/interoperability/exchange.ts` | (c) | `HealthInformationExchangeStatusChanged` | 9c |
| `dispatchExchange` | `src/lib/hospital/interoperability/exchange.ts` | (c) | `HealthInformationExchangeStatusChanged` | 9c; the record leaves the facility |
| `runReconciliation` | `src/lib/billing/reconciliation.ts` | (b) | `ReconciliationExceptionCreated` (existing) | 9; it raises exceptions without the event |
| `dispatchPendingDomainEvents` | `src/lib/events/dispatcher.ts` | — | `BOOKKEEPING` | event infrastructure |

`ImagingStudyStatusChanged` and `SpecimenStatusChanged` gained statuses, so
they are new contract versions (v2; v1 kept). One new event name:
`HealthInformationExchangeStatusChanged` (transitions after the request;
`createExchange` keeps `HealthInformationExchangeRequested`). Distinct planned
names: 81 (77 new).

## Progress

| Step | State |
|---|---|
| 9a | **in progress** (batch 6): `StockMoved` from `postLedgerEntry` covers its 10 functions; `StockBelowReorder` (cut list) wired with the reorder task; `StockDocumentStatusChanged` (adjustments, stock take, goods-receipt rejection) and `GoodsReceived` (cut list); the waste HOLD flow (approved change 4); purchase-order and supplier-invoice events. |
| 9 | **wired** (2026-10-16, batch 5) with the planned billing events (#50–54, 58, 59): 27 triage functions (36 entries, counting both `voidInvoice` and both `resolveException` paths and the planned producers). `ClaimSettled` carries `stage` (approved change 1). Charge categories became a closed set. |
| 7 | **wired** (2026-10-16, batch 5) with the step-7 planned events: 10 triage functions, plus `decideLinkRequest` (LINK → `PatientAccountLinked` FRONT_DESK), the document, note and family producers. `addPatientIdentifier` emits only for MRN/UHID; external identifiers are 9c's. |
| 8 | **wired** (2026-10-16, batch 4) with the 8 planned OT/blood events: 22 triage functions, 10 events. `BloodUnitStatusChanged` is emitted by the one unit transition every path uses, so `dispatchIssue` / `receiveIssue` (exempted as transport logistics) now emit it too (ISSUED ↔ IN_TRANSIT) and left the exemptions. `TransfusionReactionReported` has no `severity` (the model has none). |
| 4 | **wired** (2026-10-16, batch 4): 18 functions, 7 events. The admission-request, appointment no-show and transfer-request transitions became compare-and-set (they read the status, then wrote without a guard). `completeTransferRequest` also emits `TransferRequestStatusChanged` (COMPLETED), so the request's stream is whole. The task-generator cancels a bed-allocation task whose request is cancelled or rejected (it stayed open). |
| 5b | **wired** (2026-10-16): 8 functions, 4 events |
| 6 | **wired** (2026-10-16): 33 functions, 16 events, plus the 9 planned step-6 events |
| 9a | `quarantineLot` and `releaseLotFromQuarantine` were wired early with step 6: the pharmacy quarantine functions delegate to them, and emitting in the wrappers would have doubled the event at 9a. `StockLotStatusChanged` is also emitted for each lot a recall moves to RECALLED. |

## Applying it (batch 3a, done)

1. `emitExemptions.ts`: each event function is `PLANNED` with its `events` and step (`"5b"`, `"9a"`, `"9b"`, `"9c"` for the sub-steps); each exemption has its category, and `PROCESS_STEP` entries carry their `boundary` event(s). `NOT_YET_CATALOGUED` is removed from the categories, so the CI rule rejects it; a boundary event must be catalogued or owed by a `PLANNED`/`OWED_EVENTS` entry.
2. Each module's step adds its events to `catalogue.ts` and removes its `PLANNED` entries; the test accepts only the named event type.
