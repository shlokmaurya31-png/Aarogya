# Data dictionary

Every Prisma model (257), with its owner module, tenancy scope, whether it holds
PHI, and any fields that duplicate data held elsewhere. **Duplicates are listed
for decision; resolved ones say how they were resolved.**

Generated from the schema (Prisma DMMF) and the code on 2026-10-14, then
reviewed by hand. The conceptual duplicates in §1.1 are hand-written; the
rest is derived. When the schema changes, regenerate the tables rather than
editing them.

**Columns**
- **Owner**: the module that owns the model's writes (its service layer).
- **Scope**: who a row belongs to.
  - **facility**: has its own `facilityId`.
  - **facility · patient**: a facility row about one patient.
  - **organization**: `organizationId`; "or platform" when null means global.
  - **patient**: belongs to a patient, scoped through the patient's facility.
  - **user**: belongs to an account.
  - **platform**: global reference data or platform-only.
  - "(via X)": the scope comes from a required parent.
- **PHI**: **PHI** if the row is about an identifiable patient (it has a
  `patientId`, directly or through a required parent); **PII** for personal
  data of staff, students or accounts that isn't health data; otherwise
  **no**.

**Totals**: 257 models: 111 PHI, 5 PII, 141 neither.

## 1. Duplicated data (for decision)

### 1.1 Conceptual duplicates: two models for the same thing

| # | Models | What overlaps | Risk while both exist |
|---|---|---|---|
| D1 | `PatientIdentifier` ↔ `ExternalIdentifier` (entityType `PATIENT`) | Both store a patient's identifiers (type/system, value, status). `ExternalIdentifier` adds verification/sync state and covers non-patient entities. | An ABHA number or other ID can be recorded in one and missed by readers of the other; the FHIR export and the NHCX bundle read `ExternalIdentifier`, while the patient API (`/api/hospital/patients/[id]`) returns `PatientIdentifier`. |
| D2 | `Consent` ↔ `InteropConsent` | Both are patient consents with purpose, status, grant/revoke/expiry. `InteropConsent` is the ABDM/HIE one (recipient, external ref, facility). | A revocation recorded in one isn't seen by code that checks the other. **Resolved:** `Consent` was migrated into `InteropConsent` (recipient = the facility for staff-recorded consents) and dropped; every check goes through `src/lib/consent`. Gate: `verify-postgres-consent-revocation`. |
| D3 | `Problem` ↔ `Diagnosis` | Both are a patient's conditions (`diagnosis` text, status, onset). `Diagnosis` is per encounter and coded (`codeSystem`, `code`); `Problem` is the longitudinal list, uncoded. | The problem list and encounter diagnoses drift; summaries read `Problem`, the chart reads both. |
| D4 | `GeneratedDocument` ↔ `ClinicalDocument` | Both are documents about a patient with a stored file (`storageRef`, `sha256`). Generated PDFs (prescriptions, discharge summaries, invoices) live only in `GeneratedDocument`, whose `patientId` has no foreign key. | Generated PDFs don't appear in the portal's reports or the Hospital OS document list, which read `ClinicalDocument` only. |
| D5 | `Transfer` ↔ `EncounterLocation` | Both record where an admitted patient is (bed moves): `Transfer` from→to bed per admission, `EncounterLocation` bed assignment intervals per encounter. | Bed history can disagree between the two. |
| D6 | `Task` ↔ `WorkflowTask` | Two task systems (clinical tasks vs workflow-engine tasks), both with assignee, status, due date, facility. | Two worklists for staff; a task can exist in one and be invisible in the other. |
| D7 | `DoctorScheduleBlock` ↔ `StaffShift` | Both say when a staff member works (`staffId`, facility, department, time window). One drives appointment slots, the other workforce rostering. | A doctor can be on leave in one and bookable in the other. |
| D8 | `HospitalStaffProfile.facilityId` ↔ `FacilityMembership` | The staff profile's home facility duplicates a facility membership; tenancy resolution reads both (`primaryFacilityId` plus memberships). | Removing a membership doesn't change the home facility, and the other way round. **Resolved:** `HospitalStaffProfile.facilityId` is gone; the home facility is the one membership with `isPrimary` (partial unique index `FacilityMembership_one_primary_per_user`), and staff-at-facility checks use `src/lib/auth/staffFacility.ts`. |
| D9 | `Order` ↔ `MedicationOrder` / `LabOrder` / `ImagingOrder` / `Referral` | `Order` is a generic parent (optional link from each specific order) and repeats `patientId`, `encounterId`, `status`, `priority`, ordering staff and timestamps the specific orders also hold. | Two statuses per order that can disagree. |

**Same name, different domain (listed so they aren't mistaken for duplicates):**
- `Invoice`, `Payment`, `Refund` and `Claim` are patient billing; `BillingInvoice`, `BillingPayment` and `BillingRefund` are the SaaS subscription.
- `ReconciliationException` belongs to NHCX claims; `BillingReconciliationException` to SaaS payments.
- `Specimen` is a lab specimen; `SurgicalSpecimen` an OT specimen.
- `MedicationItemLink` (drug name → stock item) and `FormularyEntry` (an item's formulary status) are different things.

### 1.2 Copied values inside a model

| Model | Field | Duplicates | Note |
|---|---|---|---|
| `Patient` | `ageYears` | `dob` | Both stored; an age entered at registration goes stale and can disagree with `dob`. |
| `User` / `Patient` / `StudentProfile` | `displayName` / `fullName`, `preferredName` / `fullLegalName`, `preferredName` | each other | A person's name is held per model; a correction in one doesn't reach the others. |

| `BloodRequest` | productName | product | Copied at write time; goes stale if the source is renamed. |
| `GeneratedDocument` | issuedByName | issuedByUserId | Deliberate snapshot: the issuer as printed on the document at issue time. |
| `PatientAccessSession` | doctorName | doctorUserId | Snapshot of the doctor's name for the patient's view. |
| `Surgery` | procedureName | procedure | Copied at write time; goes stale if the source is renamed. |
| `PatientLinkRequest` | `claimedName`, `claimedPhone`, `claimedDob`, `claimedSex` | the matched `Patient` | Deliberate: what the registrant typed, kept for the reviewer. |

### 1.3 Keys copied from a parent

Rows that carry a key their parent already holds. This is deliberate across the
codebase: every row carries its own scope key so tenant filters and indexes stay
single-table, and clinical rows carry `patientId`/`encounterId` for direct reads.
The risk is drift if a parent is ever corrected (for example, an encounter
moved to the right patient) without updating its children. Patient merges are
logical and rewrite nothing, so they don't cause drift. Listed so the merge decision can include them; a
consistency gate could check that they agree.

**Patient / encounter keys** (42 models):

| Model | Copied key = parent's key |
|---|---|
| `Diagnosis` | `patientId` = encounter.patientId |
| `MedicationOrder` | `patientId` = encounter.patientId |
| `LabOrder` | `patientId` = encounter.patientId |
| `Specimen` | `patientId` = labOrder.patientId = encounter.patientId |
| `Specimen` | `encounterId` = labOrder.encounterId |
| `ImagingOrder` | `patientId` = encounter.patientId |
| `ImagingStudy` | `patientId` = imagingOrder.patientId = encounter.patientId |
| `ImagingStudy` | `encounterId` = imagingOrder.encounterId |
| `Charge` | `patientId` = encounter.patientId |
| `BillingAccount` | `patientId` = encounter.patientId |
| `Invoice` | `patientId` = billingAccount.patientId = encounter.patientId |
| `Invoice` | `encounterId` = billingAccount.encounterId |
| `Payment` | `patientId` = billingAccount.patientId |
| `Referral` | `patientId` = encounter.patientId |
| `AdmissionRequest` | `patientId` = encounter.patientId |
| `IcuObservation` | `patientId` = encounter.patientId |
| `IcuDevice` | `patientId` = encounter.patientId |
| `IcuInfusion` | `patientId` = encounter.patientId |
| `Surgery` | `patientId` = encounter.patientId |
| `SurgicalSpecimen` | `patientId` = surgery.patientId |
| `SurgicalSpecimen` | `encounterId` = surgery.encounterId |
| `SurgeryItemUsage` | `patientId` = surgery.patientId |
| `SurgeryItemUsage` | `encounterId` = surgery.encounterId |
| `Order` | `patientId` = encounter.patientId |
| `NursingAssessment` | `patientId` = encounter.patientId |
| `MedicationReconciliation` | `patientId` = encounter.patientId |
| `BloodRequest` | `patientId` = encounter.patientId |
| `BloodCompatibilityTest` | `patientId` = request.patientId |
| `BloodCompatibilityTest` | `encounterId` = request.encounterId |
| `BloodReservation` | `patientId` = request.patientId |
| `BloodReservation` | `encounterId` = request.encounterId |
| `BloodIssue` | `patientId` = request.patientId |
| `BloodIssue` | `encounterId` = request.encounterId |
| `Transfusion` | `patientId` = request.patientId |
| `Transfusion` | `encounterId` = request.encounterId |
| `TransfusionReaction` | `patientId` = transfusion.patientId |
| `TransfusionReaction` | `encounterId` = transfusion.encounterId |
| `EdReassessment` | `patientId` = encounter.patientId |
| `EdResuscitation` | `patientId` = encounter.patientId |
| `EdDisposition` | `patientId` = encounter.patientId |
| `Meal` | `patientId` = dietOrder.patientId |
| `Meal` | `encounterId` = dietOrder.encounterId |

**Tenant keys** (`facilityId` / `organizationId`, 83 models): the row's own scope key equals its parent's.

| Model | Copied key = parent's key |
|---|---|
| `WorkflowInstance` | `facilityId` = definition.facilityId |
| `WorkflowInstance` | `organizationId` = definition.organizationId |
| `WorkflowTask` | `facilityId` = instance.facilityId |
| `WorkflowTask` | `organizationId` = instance.organizationId |
| `BillingPeriod` | `organizationId` = subscription.organizationId |
| `BillingInvoice` | `organizationId` = billingAccount.organizationId |
| `BillingPaymentAttempt` | `organizationId` = invoice.organizationId |
| `BillingPayment` | `organizationId` = invoice.organizationId |
| `BillingRefund` | `organizationId` = payment.organizationId |
| `Bed` | `facilityId` = ward.facilityId |
| `EpisodeOfCare` | `facilityId` = patient.facilityId |
| `Encounter` | `facilityId` = patient.facilityId |
| `Specimen` | `facilityId` = patient.facilityId = encounter.facilityId |
| `ImagingStudy` | `facilityId` = patient.facilityId = encounter.facilityId |
| `Charge` | `facilityId` = encounter.facilityId = patient.facilityId |
| `BillingAccount` | `facilityId` = encounter.facilityId = patient.facilityId |
| `Invoice` | `facilityId` = billingAccount.facilityId = encounter.facilityId = patient.facilityId |
| `Payment` | `facilityId` = billingAccount.facilityId = patient.facilityId |
| `Claim` | `facilityId` = invoice.facilityId |
| `Task` | `facilityId` = createdBy.facilityId |
| `ClinicalDocument` | `facilityId` = patient.facilityId |
| `Appointment` | `facilityId` = doctor.facilityId = patient.facilityId |
| `DoctorScheduleBlock` | `facilityId` = staff.facilityId |
| `QueueEntry` | `facilityId` = patient.facilityId |
| `TriageAssessment` | `facilityId` = encounter.facilityId = recordedBy.facilityId |
| `EncounterLocation` | `facilityId` = encounter.facilityId |
| `AdmissionRequest` | `facilityId` = patient.facilityId = encounter.facilityId = requestedBy.facilityId |
| `TransferRequest` | `facilityId` = patient.facilityId = requestedBy.facilityId |
| `IcuObservation` | `facilityId` = patient.facilityId = encounter.facilityId |
| `IcuDevice` | `facilityId` = patient.facilityId = encounter.facilityId |
| `IcuInfusion` | `facilityId` = patient.facilityId = encounter.facilityId |
| `Surgery` | `facilityId` = patient.facilityId = encounter.facilityId |
| `SurgerySchedule` | `facilityId` = surgery.facilityId = operatingTheatre.facilityId |
| `SurgicalSpecimen` | `facilityId` = surgery.facilityId |
| `SurgeryItemUsage` | `facilityId` = surgery.facilityId |
| `Order` | `facilityId` = encounter.facilityId = patient.facilityId = orderingStaff.facilityId |
| `CarePlan` | `facilityId` = patient.facilityId |
| `NursingAssessment` | `facilityId` = patient.facilityId = encounter.facilityId = nurse.facilityId |
| `ClinicalHandoff` | `facilityId` = patient.facilityId = fromStaff.facilityId |
| `NursingAssignment` | `facilityId` = nurse.facilityId = patient.facilityId |
| `IntakeOutputRecord` | `facilityId` = encounter.facilityId |
| `MedicationReconciliation` | `facilityId` = encounter.facilityId = patient.facilityId |
| `MedicationItemLink` | `facilityId` = item.facilityId |
| `ItemLot` | `facilityId` = item.facilityId |
| `StockLedgerEntry` | `facilityId` = item.facilityId = lot.facilityId = location.facilityId |
| `StockBalance` | `facilityId` = item.facilityId = lot.facilityId = location.facilityId |
| `StockReservation` | `facilityId` = item.facilityId = lot.facilityId = location.facilityId |
| `StockTransfer` | `facilityId` = item.facilityId = lot.facilityId = fromLocation.facilityId = toLocation.facilityId |
| `StockAdjustment` | `facilityId` = item.facilityId = lot.facilityId = location.facilityId |
| `WasteRecord` | `facilityId` = item.facilityId = lot.facilityId = location.facilityId |
| `StockTake` | `facilityId` = location.facilityId |
| `PurchaseRequisition` | `facilityId` = department.facilityId |
| `PurchaseOrder` | `facilityId` = supplier.facilityId |
| `GoodsReceipt` | `facilityId` = purchaseOrder.facilityId |
| `BloodUnit` | `facilityId` = product.facilityId |
| `BloodRequest` | `facilityId` = patient.facilityId = encounter.facilityId |
| `BloodCompatibilityTest` | `facilityId` = request.facilityId |
| `BloodReservation` | `facilityId` = unit.facilityId = request.facilityId |
| `BloodIssue` | `facilityId` = unit.facilityId = request.facilityId |
| `Transfusion` | `facilityId` = request.facilityId = unit.facilityId |
| `TransfusionReaction` | `facilityId` = transfusion.facilityId = unit.facilityId |
| `EdReassessment` | `facilityId` = encounter.facilityId |
| `EdResuscitation` | `facilityId` = encounter.facilityId |
| `EdDisposition` | `facilityId` = encounter.facilityId |
| `FormularyEntry` | `facilityId` = item.facilityId |
| `SupplierContract` | `facilityId` = supplier.facilityId |
| `RfqQuotation` | `facilityId` = rfq.facilityId = supplier.facilityId |
| `SupplierInvoice` | `facilityId` = supplier.facilityId |
| `Meal` | `facilityId` = dietOrder.facilityId |
| `BiomedicalCalibrationRecord` | `facilityId` = equipment.facilityId |
| `BiomedicalMaintenanceRecord` | `facilityId` = equipment.facilityId |
| `EquipmentMovement` | `facilityId` = equipment.facilityId |
| `InfectionInvestigation` | `facilityId` = incident.facilityId |
| `ExposureRecord` | `facilityId` = incident.facilityId |
| `QualityIncidentTransition` | `facilityId` = incident.facilityId |
| `RootCauseAnalysis` | `facilityId` = incident.facilityId |
| `QualityMeasure` | `facilityId` = standard.facilityId |
| `IntegrationConfigRevision` | `facilityId` = connection.facilityId |
| `IntegrationCertificate` | `facilityId` = connection.facilityId |
| `ClaimSubmission` | `facilityId` = claim.facilityId |
| `ClaimSubmissionDocument` | `facilityId` = submission.facilityId |
| `ClaimQuery` | `facilityId` = submission.facilityId |
| `Notification` | `facilityId` = recipient.facilityId |

## 2. Models by owner module

### ICU (src/lib/hospital/icu)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `IcuDevice` | facility · patient | PHI | §1.3 |
| `IcuInfusion` | facility · patient | PHI | §1.3 |
| `IcuObservation` | facility · patient | PHI | §1.3 |
| `IcuUnit` | facility | no | — |

### NHCX claims (src/lib/hospital/nhcx)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `ClaimQuery` | facility · patient | PHI | §1.3 |
| `ClaimSettlement` | facility | no | — |
| `ClaimSubmission` | facility · patient | PHI | §1.3 |
| `ClaimSubmissionDocument` | facility · patient | PHI | §1.3 |
| `NhcxCallbackEvent` | facility | no | — |
| `NhcxExchange` | facility | no | — |
| `ReconciliationException` | facility | no | — |

### SaaS billing (src/lib/billing)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `BillingAccount` | facility · patient | PHI | §1.3 |
| `BillingCredit` | organization | no | — |
| `BillingInvoice` | organization | no | §1.3 |
| `BillingInvoiceLine` | organization (via BillingInvoice) | no | — |
| `BillingInvoiceSequence` | platform | no | — |
| `BillingPayment` | organization | no | §1.3 |
| `BillingPaymentAttempt` | organization | no | §1.3 |
| `BillingPeriod` | organization | no | §1.3 |
| `BillingReconciliationException` | organization or platform (null = global) | no | — |
| `BillingRefund` | organization | no | §1.3 |
| `BillingWebhookEvent` | platform | no | — |
| `CollectionActivity` | organization | no | — |
| `OrganizationBillingAccount` | organization | no | — |

### auth (src/lib/auth)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `User` | platform | PII | §1.2 |

### auth/audit (src/lib/auth/audit.ts)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `AuditEvent` | organization (facility optional) | PHI | — |

### auth/authorize (src/lib/auth/authorize)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `BreakGlassAccess` | facility · patient | PHI | — |
| `PrivacyRequest` | facility · patient | PHI | — |

### blood bank (src/lib/hospital/blood)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `BloodCompatibilityTest` | facility · patient | PHI | §1.3 |
| `BloodIssue` | facility · patient | PHI | §1.3 |
| `BloodProduct` | facility | no | — |
| `BloodRequest` | facility · patient | PHI | §1.2, §1.3 |
| `BloodReservation` | facility · patient | PHI | §1.3 |
| `BloodTypingRecord` | facility · patient | PHI | — |
| `BloodUnit` | facility | no | §1.3 |
| `Transfusion` | facility · patient | PHI | §1.3 |
| `TransfusionObservation` | facility · patient (via Transfusion) | PHI | — |
| `TransfusionReaction` | facility · patient | PHI | §1.3 |

### clinical (src/lib/hospital)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `CarePlan` | facility · patient | PHI | §1.3 |
| `CarePlanIntervention` | facility · patient (via CarePlan) | PHI | — |
| `ClinicalDocument` | facility · patient | PHI | §1.1 D4, §1.3 |
| `ClinicalHandoff` | facility · patient | PHI | §1.3 |
| `ClinicalNote` | facility · patient (via Encounter) | PHI | — |
| `Diagnosis` | facility · patient (via Patient) | PHI | §1.1 D3, §1.3 |
| `IntakeOutputRecord` | facility · patient | PHI | §1.3 |
| `NursingAssessment` | facility · patient | PHI | §1.3 |
| `NursingAssignment` | facility · patient | PHI | §1.3 |
| `Order` | facility · patient | PHI | §1.1 D9, §1.3 |
| `Procedure` | facility | no | — |
| `Referral` | facility · patient (via Patient) | PHI | §1.1 D9, §1.3 |
| `Task` | facility · patient | PHI | §1.1 D6, §1.3 |
| `Vital` | facility · patient (via Encounter) | PHI | — |

### clinical config (src/lib/hospital)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `SlaPolicy` | facility | no | — |
| `VitalThreshold` | facility | no | — |

### commercial (src/lib/commercial)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `EntitlementDefinition` | platform | no | — |
| `FacilityEntitlementOverride` | facility | no | — |
| `OrganizationEntitlementOverride` | organization | no | — |
| `OrganizationSubscription` | organization | no | — |
| `PlanEntitlement` | platform | no | — |
| `PlanPrice` | platform | no | — |
| `SubscriptionEntitlement` | organization (via OrganizationSubscription) | no | — |
| `SubscriptionPlan` | platform | no | — |

### config (src/lib/config)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `ConfigurationChange` | organization | no | — |
| `ConfigurationOverride` | organization (facility optional) | no | — |
| `DepartmentConfigValue` | facility (via Department) | no | — |
| `FacilityConfigValue` | facility | no | — |
| `OrgConfigValue` | organization | no | — |

### diagnostics (src/lib/hospital)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `ExternalLabReferral` | facility · patient | PHI | — |
| `ImagingCatalog` | facility (optional) / platform | no | — |
| `ImagingOrder` | facility · patient (via Encounter) | PHI | §1.1 D9, §1.3 |
| `ImagingReport` | facility · patient (via HospitalStaffProfile) | PHI | — |
| `ImagingResource` | facility | no | — |
| `ImagingStudy` | facility · patient | PHI | §1.3 |
| `LabCalibrationRecord` | facility | no | — |
| `LabOrder` | facility · patient (via Encounter) | PHI | §1.1 D9, §1.3 |
| `LabPanel` | facility (optional) / platform | no | — |
| `LabPanelTest` | facility (via LabPanel) | no | — |
| `LabQcRecord` | facility | no | — |
| `LabReferenceRange` | facility (via LabTestCatalog) | no | — |
| `LabResult` | patient | PHI | — |
| `LabTestCatalog` | facility (optional) / platform | no | — |
| `Specimen` | facility · patient | PHI | §1.3 |

### documents (src/lib/documents)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `GeneratedDocument` | facility · patient | PHI | §1.1 D4, §1.2 |

### emergency (src/lib/hospital/emergency)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `EdDisposition` | facility · patient | PHI | §1.3 |
| `EdReassessment` | facility · patient | PHI | §1.3 |
| `EdResuscitation` | facility · patient | PHI | §1.3 |

### enterprise (src/lib/enterprise)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `Department` | facility | no | — |
| `DepartmentMembership` | facility (via HospitalStaffProfile) | no | — |
| `Facility` | organization | no | — |
| `FacilityMembership` | facility | no | §1.1 D8 (resolved; `isPrimary` = home facility) |
| `Organization` | platform | no | — |
| `OrganizationMembership` | organization | no | — |

### events (src/lib/events)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `DomainEventDelivery` | facility (via DomainEventOutbox) | no | — |
| `DomainEventOutbox` | organization (facility optional) | no | — |

### hospital billing (src/lib/hospital/billing)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `Charge` | facility · patient | PHI | §1.3 |
| `Claim` | facility · patient | PHI | §1.3 |
| `ClaimLine` | facility · patient (via Claim) | PHI | — |
| `FinancialAdjustment` | facility · patient (via Invoice) | PHI | — |
| `Invoice` | facility · patient | PHI | §1.3 |
| `InvoiceLine` | facility · patient (via Invoice) | PHI | — |
| `InvoiceSequence` | facility | no | — |
| `PackageDefinition` | facility | no | — |
| `PackageItem` | facility (via PackageDefinition) | no | — |
| `PatientCoverage` | facility · patient (via Patient) | PHI | — |
| `Payer` | platform | no | — |
| `PayerPlan` | platform | no | — |
| `Payment` | facility · patient | PHI | §1.3 |
| `PaymentAllocation` | facility · patient (via Payment) | PHI | — |
| `PreAuthorization` | facility · patient (via Encounter) | PHI | — |
| `Refund` | facility · patient (via Payment) | PHI | — |
| `Tariff` | facility | no | — |

### interoperability (src/lib/hospital/interoperability)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `AbdmCallbackEvent` | facility | no | — |
| `ExternalIdentifier` | facility | no | §1.1 D1 |
| `ExternalParticipant` | facility | no | — |
| `HealthInformationExchange` | facility · patient | PHI | — |
| `ImportedResource` | facility | no | — |
| `IntegrationAlert` | facility | no | — |
| `IntegrationCertificate` | facility | no | §1.3 |
| `IntegrationConfigRevision` | facility | no | §1.3 |
| `InteropConnection` | facility | no | — |
| `InteropConsent` | facility · patient | PHI | §1.1 D2 (resolved; the only consent model) |
| `InteropConsentScope` | facility · patient (via InteropConsent) | PHI | — |
| `InteropProvenance` | facility · patient | PHI | — |
| `TerminologyMapping` | facility (optional) / platform | no | — |

### inventory (src/lib/hospital/inventory)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `InventorySerial` | facility | no | — |
| `Item` | facility (optional) / platform | no | — |
| `ItemLot` | facility | no | §1.3 |
| `ItemUnitConversion` | facility (via Item) | no | — |
| `StockAdjustment` | facility | no | §1.3 |
| `StockBalance` | facility | no | §1.3 |
| `StockLedgerEntry` | facility · patient | PHI | §1.3 |
| `StockLocation` | facility | no | — |
| `StockReservation` | facility · patient | PHI | §1.3 |
| `StockTake` | facility | no | §1.3 |
| `StockTakeLine` | facility (via StockTake) | no | — |
| `StockTransfer` | facility | no | §1.3 |
| `WasteRecord` | facility · patient | PHI | §1.3 |

### notifications (src/lib/hospital/notifications.ts)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `Notification` | facility · patient | PHI | §1.3 |

### operating theatre (src/lib/hospital/surgery)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `AnesthesiaRecord` | facility · patient (via Surgery) | PHI | — |
| `OperatingTheatre` | facility | no | — |
| `RecoveryRecord` | facility · patient (via Surgery) | PHI | — |
| `Surgery` | facility · patient | PHI | §1.2, §1.3 |
| `SurgeryChecklistItem` | facility · patient (via Surgery) | PHI | — |
| `SurgeryItemUsage` | facility · patient | PHI | §1.3 |
| `SurgerySchedule` | facility · patient | PHI | §1.3 |
| `SurgeryTeamMember` | facility · patient (via Surgery) | PHI | — |
| `SurgicalSpecimen` | facility · patient | PHI | §1.3 |

### operations (src/lib/hospital/operations)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `Ambulance` | facility | no | — |
| `AmbulanceTrip` | facility · patient | PHI | — |
| `AssetDowntime` | facility | no | — |
| `BiomedicalCalibrationRecord` | facility | no | §1.3 |
| `BiomedicalEquipment` | facility | no | — |
| `BiomedicalMaintenanceRecord` | facility | no | §1.3 |
| `DietOrder` | facility · patient | PHI | — |
| `EquipmentMovement` | facility | no | §1.3 |
| `HousekeepingRequest` | facility | no | — |
| `MaintenanceRequest` | facility | no | — |
| `Meal` | facility · patient | PHI | §1.3 |
| `PatientTransportRequest` | facility · patient | PHI | — |
| `PreventiveMaintenance` | facility | no | — |

### patient core (src/lib/patient)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `Allergy` | facility · patient (via Patient) | PHI | — |
| `EpisodeOfCare` | facility · patient | PHI | §1.3 |
| `Patient` | facility · patient | PHI | §1.2 |
| `PatientEmergencyContact` | facility · patient (via Patient) | PHI | — |
| `PatientIdentifier` | facility · patient (via Patient) | PHI | §1.1 D1 |
| `PatientMergeRecord` | facility · patient (via Patient) | PHI | — |
| `Problem` | facility · patient (via Patient) | PHI | §1.1 D3 |

### patient flow (src/lib/hospital)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `Admission` | facility · patient (via Encounter) | PHI | — |
| `AdmissionRequest` | facility · patient | PHI | §1.3 |
| `Appointment` | facility · patient | PHI | §1.3 |
| `Bed` | facility | no | §1.3 |
| `BedStateEvent` | facility · patient (via Bed) | PHI | — |
| `Discharge` | patient | PHI | — |
| `DoctorScheduleBlock` | facility | no | §1.1 D7, §1.3 |
| `Encounter` | facility · patient | PHI | §1.3 |
| `EncounterLocation` | facility · patient | PHI | §1.1 D5, §1.3 |
| `QueueEntry` | facility · patient | PHI | §1.3 |
| `Transfer` | facility · patient (via Bed) | PHI | §1.1 D5 |
| `TransferRequest` | facility · patient | PHI | §1.3 |
| `TriageAssessment` | facility · patient | PHI | §1.3 |
| `Ward` | facility | no | — |

### patient portal (src/lib/patient)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `PatientAccessSession` | facility (optional) / platform | PHI | §1.2 |
| `PatientDelegation` | facility · patient (via Patient) | PHI | — |
| `PatientDelegationScope` | patient | PHI | — |
| `PatientLinkRequest` | facility | no | §1.2 |

### pharmacy (src/lib/hospital/pharmacy, medicationLifecycle)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `DispensingRecord` | facility · patient (via HospitalStaffProfile) | PHI | — |
| `FormularyEntry` | facility | no | §1.3 |
| `MedicationAdministration` | patient | PHI | — |
| `MedicationItemLink` | organization (facility optional) | no | §1.3 |
| `MedicationOrder` | facility · patient (via Encounter) | PHI | §1.1 D9, §1.3 |
| `MedicationRecall` | facility | no | — |
| `MedicationReconciliation` | facility · patient | PHI | §1.3 |
| `MedicationReturn` | facility · patient | PHI | — |
| `MedicationSafetyWarning` | patient | PHI | — |
| `MedicationSubstitution` | facility · patient | PHI | — |
| `MedicationVerification` | facility · patient (via HospitalStaffProfile) | PHI | — |
| `PharmacyRequest` | facility · patient | PHI | — |
| `PharmacyStorageCheck` | facility | no | — |

### procurement (src/lib/hospital/procurement)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `DepartmentSupplyRequest` | facility · patient | PHI | — |
| `GoodsReceipt` | facility | no | §1.3 |
| `GoodsReceiptLine` | facility (via GoodsReceipt) | no | — |
| `GoodsReceiptSequence` | facility | no | — |
| `PurchaseOrder` | facility | no | §1.3 |
| `PurchaseOrderLine` | facility (via PurchaseOrder) | no | — |
| `PurchaseOrderSequence` | facility | no | — |
| `PurchaseRequisition` | facility | no | §1.3 |
| `PurchaseRequisitionLine` | facility (via PurchaseRequisition) | no | — |
| `PurchaseRequisitionSequence` | facility | no | — |
| `Rfq` | facility | no | — |
| `RfqLine` | facility (via Rfq) | no | — |
| `RfqQuotation` | facility | no | §1.3 |
| `RfqQuotationLine` | facility (via RfqQuotation) | no | — |
| `Supplier` | facility | no | — |
| `SupplierContract` | facility | no | §1.3 |
| `SupplierInvoice` | facility | no | §1.3 |

### quality & infection control (src/lib/hospital/quality, operations)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `CapaAction` | facility | no | — |
| `ComplianceEvidence` | facility | no | — |
| `ExposureRecord` | facility · patient | PHI | §1.3 |
| `InfectionIncident` | facility · patient | PHI | — |
| `InfectionInvestigation` | facility · patient | PHI | §1.3 |
| `QualityAudit` | facility | no | — |
| `QualityFinding` | facility | no | — |
| `QualityIncident` | facility · patient | PHI | — |
| `QualityIncidentTransition` | facility · patient | PHI | §1.3 |
| `QualityMeasure` | facility | no | §1.3 |
| `QualityStandard` | facility | no | — |
| `RootCauseAnalysis` | facility · patient | PHI | §1.3 |

### scholar (src/lib/verification, caseEngine, student APIs)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `Achievement` | platform | no | — |
| `Assignment` | platform | no | — |
| `AssignmentSubmission` | user (platform) | no | — |
| `CaseAction` | platform | no | — |
| `CaseAttempt` | user (platform) | no | — |
| `ClinicalCase` | user (platform) | no | — |
| `Cohort` | platform | no | — |
| `CohortMembership` | user (platform) | no | — |
| `Institution` | platform | no | — |
| `InstitutionDomain` | platform | no | — |
| `LearningRecommendation` | platform | no | — |
| `NotebookEntry` | user (platform) | no | — |
| `StudentAchievement` | user (platform) | no | — |
| `StudentCompetency` | user (platform) | no | — |
| `StudentProfile` | user (platform) | PII | §1.2 |
| `VerificationDocument` | platform | no | — |

### workflows (src/lib/workflows, workflow-builder)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `WorkflowBuilderDraft` | organization (facility optional) | no | — |
| `WorkflowDefinition` | organization (facility optional) | no | — |
| `WorkflowInstance` | organization (facility optional) | no | §1.3 |
| `WorkflowStep` | facility (via WorkflowInstance) | no | — |
| `WorkflowTask` | organization (facility optional) | PHI | §1.1 D6, §1.3 |
| `WorkflowTimer` | facility (via WorkflowInstance) | no | — |
| `WorkflowVersion` | facility (via WorkflowDefinition) | no | — |

### workforce (src/lib/hospital/workforce)

| Model | Scope | PHI | Duplicates |
|---|---|---|---|
| `Credential` | facility | PII | — |
| `HospitalStaffProfile` | user (facility via `FacilityMembership`) | PII | §1.1 D8 (resolved) |
| `StaffAvailability` | facility | no | — |
| `StaffPrivilege` | facility | PII | — |
| `StaffShift` | facility | no | §1.1 D7 |
| `StaffingRequirement` | facility | no | — |
| `WorkforceAssignment` | facility | no | — |

