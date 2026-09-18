# Event Catalogue

Every emittable event is declared once in `src/lib/events/catalogue.ts` with a
versioned, `.strict()` Zod payload contract. The catalogue is the single source of
truth for legal event types/versions, payload shape, aggregate, tenant scope,
sensitivity, and producing service. Unknown types/versions are rejected on emit
**and** on dispatch/replay.

Only **meaningful domain facts** are events — not every database mutation.

## Events shipped in D6

| Event | Aggregate | Scope | Sensitivity | Producer | Payload |
|---|---|---|---|---|---|
| `PatientRegistered` | PATIENT | FACILITY | INTERNAL | patient registration | `patientId`, `uhid?` |
| `AppointmentBooked` | APPOINTMENT | FACILITY | INTERNAL | `bookAppointment` | `appointmentId`, `patientId`, `doctorStaffId`, `scheduledStart` |
| `AdmissionCreated` | ADMISSION | FACILITY | INTERNAL | `admitPatient` | `admissionId`, `encounterId`, `patientId`, `bedId?` |
| `MedicationOrdered` | MEDICATION_ORDER | FACILITY | INTERNAL | `createMedicationOrder` | `orderId`, `patientId`, `encounterId?` |
| `LabResultReleased` | LAB_RESULT | FACILITY | INTERNAL | `verifyResult` | `resultId`, `orderId?`, `patientId?`, `critical?` |
| `ImagingReportReleased` | IMAGING_REPORT | FACILITY | INTERNAL | `verifyReport` | `reportId`, `studyId?`, `patientId?`, `critical?` |
| `ConsentGranted` | CONSENT | FACILITY | SENSITIVE | interop consent | `consentId`, `patientId` |
| `ConsentRevoked` | CONSENT | FACILITY | SENSITIVE | interop consent | `consentId`, `patientId` |
| `SubscriptionActivated` | SUBSCRIPTION | ORGANIZATION | LOW | `assignPlan` | `subscriptionId`, `planId`, `billingInterval` |
| `SubscriptionRenewed` | SUBSCRIPTION | ORGANIZATION | LOW | `applyPaidRenewal` | `subscriptionId`, `periodStart`, `periodEnd` |
| `SubscriptionCancelled` | SUBSCRIPTION | ORGANIZATION | LOW | `cancelSubscription` | `subscriptionId`, `immediate` |
| `InvoiceCreated` | INVOICE | ORGANIZATION | LOW | `generateInvoiceForPeriod` | `invoiceId`, `totalMinor`, `currency` |
| `InvoiceFinalized` | INVOICE | ORGANIZATION | LOW | `finalizeInvoiceTx` | `invoiceId`, `invoiceNumber`, `totalMinor`, `currency` |
| `PaymentReceived` | PAYMENT | ORGANIZATION | LOW | `recordPayment` | `paymentId`, `invoiceId`, `amountMinor`, `currency` |
| `PaymentFailed` | PAYMENT | ORGANIZATION | LOW | payments/webhooks | `attemptId`, `invoiceId?`, `amountMinor`, `currency`, `failureCode?` |
| `RefundIssued` | REFUND | ORGANIZATION | LOW | `refundPaymentTx` | `refundId`, `paymentId`, `amountMinor`, `currency` |
| `ReconciliationExceptionCreated` | RECONCILIATION_EXCEPTION | ORGANIZATION | LOW | reconciliation/leakage | `exceptionId`, `kind`, `severity`, `source` |
| `ReconciliationExceptionResolved` | RECONCILIATION_EXCEPTION | ORGANIZATION | LOW | `transitionException` | `exceptionId`, `status` |

`PaymentFailed` is declared for the webhook/attempt path; several additional
lifecycle facts are catalogue-ready but intentionally not yet emitted from every
site (see the phase report's Deferred section).

## Scope rules

- **ORGANIZATION / FACILITY** events must carry a server-derived `organizationId`
  (facility events also a `facilityId`, resolved via `facilityOrganizationId`).
- Scope is never taken from client input.

## Adding an event

1. Add a `contract({...})` entry with a new `.strict()` payload schema.
2. Emit it from the domain service **inside the mutation's transaction**.
3. It is delivered to every registered consumer that `handles` it.
