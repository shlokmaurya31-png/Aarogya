/**
 * Workflow spine §6 — exported service functions that write without emitting a
 * domain event, each with a category and reason. The CI rule
 * (emitCoverage.test.ts) fails on a writer that neither emits nor is listed
 * here, and on a listed entry that no longer writes or now emits (stale), so
 * this list can only be changed deliberately and shrinks as events are wired.
 *
 * Categories:
 *   PLANNED              — must emit the listed event type(s) in the named §9 step
 *                          (0 = cut list; "5b", "9a", "9b", "9c" are the triage's
 *                          sub-steps); only those types satisfy it. Remove the
 *                          entry in the commit that wires it.
 *   BOOKKEEPING          — infrastructure, derived status, sequences, helpers that
 *                          run inside another operation's transaction, projections.
 *   REFERENCE_DATA       — catalogue / master data; no runtime reaction depends on it.
 *   CONFIGURATION        — tenant, configuration or integration administration.
 *   PROCESS_STEP         — an intermediate step (draft, request, pending approval)
 *                          whose outcome is emitted by the named `boundary` event(s).
 *   OPERATIONAL_DETAIL   — logistics or housekeeping with no effect on care, money,
 *                          stock, access or safety.
 *   INTEGRATION_PROTOCOL — inbound callback logs and protocol state of external
 *                          exchanges; the changes they cause emit their own events.
 *   CONSUMER_OUTPUT      — written by an event consumer in reaction to another event.
 *
 * There is no "not yet catalogued" category: every writer is either an event
 * (PLANNED until wired) or a named exemption (docs/EVENT_TRIAGE.md, approved
 * 2026-10-16). The CI rule rejects any other category.
 *
 * Generated from the code on 2026-10-15 (phase B step 2), then reviewed;
 * the former NOT_YET_CATALOGUED entries were converted from the triage in
 * batch 3a.
 */
export const EMIT_EXEMPTION_CATEGORIES = [
  "PLANNED", "BOOKKEEPING", "REFERENCE_DATA", "CONFIGURATION",
  "PROCESS_STEP", "OPERATIONAL_DETAIL", "INTEGRATION_PROTOCOL", "CONSUMER_OUTPUT",
  // Batch 7: the Scholar learning product (outside the hospital workflow spine), and
  // account credentials (audited; an event must never carry a credential).
  "SCHOLAR", "ACCOUNT_SECURITY",
] as const;
export type EmitExemptionCategory = (typeof EMIT_EXEMPTION_CATEGORIES)[number];

/** A §9 wiring step: a number, or one of the triage's sub-steps. */
export type SpineStep = number | "5b" | "9a" | "9b" | "9c";

export interface EmitExemption {
  category: EmitExemptionCategory;
  reason: string;
  /** For PLANNED: the §9 wiring step (0 = cut list). */
  step?: SpineStep;
  /**
   * For PLANNED: the event type(s) the function must emit. Only these satisfy
   * the entry; emitting a different event (e.g. TaskCreated) does not. The entry
   * is stale, and fails the test, once the function emits all of them.
   */
  events?: string[];
  /**
   * For PROCESS_STEP: the event(s) that emit the process's outcome. Each must
   * be catalogued or owed by a PLANNED / OWED_EVENTS entry.
   */
  boundary?: string[];
}

/**
 * Events whose fact is itself sensitive (docs/EVENT_TRIAGE.md, Sensitivity;
 * ConsentExpired and TransfusionReactionStatusChanged confirmed in batch 4).
 * A catalogued contract with one of these names must be SENSITIVE; the test
 * also checks each name is catalogued or still owed.
 */
export const SENSITIVE_EVENTS: readonly string[] = [
  "ConsentGranted", "ConsentRevoked", "ConsentExpired",
  "MedicationDoseMissed", "MedicationDoseNotGiven", "TransfusionReactionReported", "TransfusionReactionStatusChanged",
  "FamilyAccessGranted", "FamilyAccessRevoked",
  "ResuscitationStatusChanged", "BreakGlassStatusChanged", "LegalHoldSet",
  "PrivacyRequestStatusChanged", "InfectionExposureRecorded",
  // Consent facts are SENSITIVE (like ConsentGranted / ConsentRevoked).
  "ConsentRequestStatusChanged",
  // Phase 0: linking a facility record to a person says who the person is.
  "PersonPatientLinked", "PersonPatientUnlinked", "PersonMerged",
  "PersonAccountClosed", "PersonAccountReopened", "PersonDataPurged",
  // A person's choice about who sees their data is a consent fact.
  "PersonConsentDecided",
];

/**
 * Closed codes a payload must carry once its contract is catalogued: the
 * conditions on the approved cross-aggregate merges (triage, approved change
 * 2) and the settlement stage (approved change 1).
 */
export const REQUIRED_PAYLOAD_FIELDS: Record<string, string[]> = {
  StockDocumentStatusChanged: ["documentType"],
  StaffAuthorizationChanged: ["changeType", "subjectStaffId"],
  ClaimSettled: ["stage"],
};

/**
 * Shared helpers that emit, with the event types they emit (workflow spine §6).
 * A caller is satisfied when it reaches a registered helper through any chain of
 * calls inside src/lib; an unregistered helper counts one level deep only. The
 * test checks that each helper really emits what it declares.
 */
export const EMITTING_HELPERS: Record<string, string[]> = {
  "src/lib/hospital/task.ts#createTask": ["TaskCreated"],
  "src/lib/hospital/task.ts#closeTask": ["TaskCompleted"],
  "src/lib/hospital/admission.ts#emitIcuAdmittedIfEntering": ["IcuAdmitted"],
  "src/lib/hospital/admission.ts#transferPatientInTx": ["PatientTransferred"],
  "src/lib/billing/payments.ts#emitPaymentFailed": ["PaymentFailed"],
  "src/lib/patient/registration.ts#createRegisteredPatient": ["PatientRegistered"],
  // Phase 0: every verified link goes through it (sign-up, the code, and the request paths).
  "src/lib/person/person.ts#recordActiveLink": ["PersonPatientLinked"],
  "src/lib/hospital/inventory/lots.ts#quarantineLot": ["StockLotStatusChanged"],
  "src/lib/hospital/billing/claims.ts#emitClaimSettled": ["ClaimSettled"],
  "src/lib/hospital/inventory/ledger.ts#postLedgerEntry": ["StockMoved", "StockBelowReorder"],
  "src/lib/hospital/billing/claims.ts#emitClaimSubmitted": ["ClaimSubmitted"],
  "src/lib/hospital/inventory/lots.ts#releaseLotFromQuarantine": ["StockLotStatusChanged"],
};

export const EMIT_EXEMPTIONS: Record<string, EmitExemption> = {
  "src/lib/auth/credentials.ts#replacePasswordHash": { category: "ACCOUNT_SECURITY", reason: "password change and reset; audited (security.password.*), never an event: events must not carry credentials" },
  "src/lib/hospital/admission.ts#updateDischargePlan": { category: "OPERATIONAL_DETAIL", reason: "staff readiness flags and expected discharge time, read only by finalizeDischarge; a hold (DischargeHoldChanged) is the event-bearing block" },
  "src/lib/hospital/encounterRecords.ts#updateEncounterDetails": { category: "OPERATIONAL_DETAIL", reason: "triage level and attending clinician on the encounter row; status changes emit through transitionEncounter" },
  "src/lib/hospital/encounterRecords.ts#assignEncounterLocation": { category: "OPERATIONAL_DETAIL", reason: "in-encounter location (bed or area label); bed placement is AdmissionCreated / PatientTransferred" },
  "src/lib/hospital/encounterRecords.ts#createEpisodeOfCare": { category: "OPERATIONAL_DETAIL", reason: "groups encounters for display; no reaction depends on it" },
  "src/lib/hospital/interoperability/connections.ts#configureInteropConnection": { category: "CONFIGURATION", reason: "a facility's connection settings for an external system (credentials refused)" },
  "src/lib/hospital/scheduleBlocks.ts#createScheduleBlock": { category: "CONFIGURATION", reason: "clinic sessions and leave; bookability reads them on demand" },
  "src/lib/student/accounts.ts#registerStudentAccount": { category: "SCHOLAR", reason: "Scholar student account and verification submission; audited" },
  "src/lib/student/accounts.ts#reviewStudentVerification": { category: "SCHOLAR", reason: "Scholar verification decision; audited" },
  "src/lib/student/accounts.ts#setOwnVerificationStatusForDev": { category: "SCHOLAR", reason: "dev-only verification shortcut (disabled in production)" },
  "src/lib/student/cases.ts#openCaseAttempt": { category: "SCHOLAR", reason: "Scholar case attempt; audited" },
  "src/lib/student/cases.ts#recordCaseAction": { category: "SCHOLAR", reason: "Scholar case action; audited" },
  "src/lib/student/cases.ts#submitCaseAttempt": { category: "SCHOLAR", reason: "Scholar submission and XP; audited" },
  "src/lib/student/cases.ts#createClinicalCaseDraft": { category: "SCHOLAR", reason: "an educator's draft teaching case (synthetic, redacted); audited" },
  "src/lib/student/notebook.ts#createNotebookEntry": { category: "SCHOLAR", reason: "a student's private note" },
  "src/lib/student/notebook.ts#deleteNotebookEntry": { category: "SCHOLAR", reason: "a student's private note" },
  "src/lib/auth/audit.ts#recordAuditEvent": { category: "BOOKKEEPING", reason: "event/audit infrastructure" },
  "src/lib/auth/authorize/engine.ts#authorizeAccess": { category: "BOOKKEEPING", reason: "derived status, decision log or provenance written as part of another operation" },
  "src/lib/auth/authorize/sessionControl.ts#revokeAllSessions": { category: "BOOKKEEPING", reason: "derived status, decision log or provenance written as part of another operation" },
  "src/lib/billing/billingAccount.ts#getOrCreateBillingAccount": { category: "BOOKKEEPING", reason: "derived balance / get-or-create helper called inside a larger operation" },
  "src/lib/billing/billingAccount.ts#setProviderCustomerRef": { category: "INTEGRATION_PROTOCOL", reason: "payment-provider customer reference" },
  "src/lib/billing/billingAccount.ts#syncProviderCustomer": { category: "INTEGRATION_PROTOCOL", reason: "payment-provider customer sync" },
  "src/lib/billing/billingAccount.ts#updateBillingAccount": { category: "OPERATIONAL_DETAIL", reason: "billing contact details; no money moves" },
  "src/lib/billing/bootstrap.ts#ensureBillingBootstrap": { category: "BOOKKEEPING", reason: "idempotent bootstrap / one-off migration" },
  // Phase 0 — steps of linking/unlinking a record to a Person; the outcome is
  // emitted when the link becomes ACTIVE (or is refused/ends) or UNLINKED.
  "src/lib/person/linking.ts#submitSecondFactor": { category: "PROCESS_STEP", reason: "second factor checked, code sent (or moved to in-person); the outcome is the link", boundary: ["PersonPatientLinked"] },
  "src/lib/person/linking.ts#startInPersonVerification": { category: "PROCESS_STEP", reason: "first staff member's ID check; a second approves and the person confirms", boundary: ["PersonPatientLinked"] },
  "src/lib/person/linking.ts#approveInPersonVerification": { category: "PROCESS_STEP", reason: "second staff member's approval; the person still confirms", boundary: ["PersonPatientLinked"] },
  "src/lib/person/linking.ts#offerAbhaLink": { category: "PROCESS_STEP", reason: "ABHA match offered; the person confirms (disabled until ABDM verification)", boundary: ["PersonPatientLinked"] },
  "src/lib/person/linking.ts#startReverification": { category: "PROCESS_STEP", reason: "a migrated link's verification opened (same routes as a new link); the outcome is the link", boundary: ["PersonPatientLinked"] },
  "src/lib/person/merge.ts#startPersonMerge": { category: "PROCESS_STEP", reason: "the other account's password checked and a code sent to each account; the outcome is the merge", boundary: ["PersonMerged"] },
  "src/lib/person/documents.ts#movePersonUploads": { category: "BOOKKEEPING", reason: "one-off migration of existing uploads to PersonDocument (same bytes); refuses rather than guesses" },
  "src/lib/person/documents.ts#personDocumentDownload": { category: "BOOKKEEPING", reason: "access log and audit of a staff read; no state change" },
  "src/lib/person/linking.ts#requestFacilityUnlink": { category: "PROCESS_STEP", reason: "first staff member's unlink request; a second approves", boundary: ["PersonPatientUnlinked"] },
  "src/lib/billing/invoices.ts#addInvoiceLine": { category: "PROCESS_STEP", reason: "edit to a draft invoice; money moves on InvoiceFinalized", boundary: ["InvoiceFinalized", "InvoiceVoided"] },
  "src/lib/billing/invoices.ts#refreshInvoicePaymentStatus": { category: "BOOKKEEPING", reason: "derived status, decision log or provenance written as part of another operation" },
  "src/lib/billing/payments.ts#createPaymentAttempt": { category: "PROCESS_STEP", reason: "an attempt; its outcome is PaymentReceived / PaymentFailed", boundary: ["PaymentReceived", "PaymentFailed"] },
  "src/lib/billing/sequence.ts#nextInvoiceSequence": { category: "BOOKKEEPING", reason: "number sequence" },
  "src/lib/commercial/analytics/collections.ts#recordCollectionActivity": { category: "OPERATIONAL_DETAIL", reason: "collections note" },
  "src/lib/commercial/analytics/reconciliationIntel.ts#assignException": { category: "OPERATIONAL_DETAIL", reason: "assigns an exception to an operator" },
  "src/lib/commercial/bootstrap.ts#ensureCommercialBootstrap": { category: "BOOKKEEPING", reason: "idempotent bootstrap / one-off migration" },
  "src/lib/commercial/overrides.ts#removeFacilityOverride": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/commercial/overrides.ts#removeOrganizationOverride": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/commercial/overrides.ts#setFacilityOverride": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/commercial/overrides.ts#setOrganizationOverride": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/commercial/plans.ts#createPlan": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/commercial/plans.ts#setPlanEntitlement": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/commercial/plans.ts#updatePlan": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/commercial/subscriptions.ts#ensureDefaultSubscription": { category: "BOOKKEEPING", reason: "idempotent bootstrap / one-off migration" },
  "src/lib/commercial/subscriptions.ts#syncSubscriptionEntitlements": { category: "BOOKKEEPING", reason: "derived status, decision log or provenance written as part of another operation" },
  "src/lib/config/overrides.ts#publishOverride": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/config/overrides.ts#resetOverride": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/config/overrides.ts#setOverride": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/configuration.ts#resetDepartmentConfig": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/configuration.ts#resetFacilityConfig": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/configuration.ts#resetOrgConfig": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/configuration.ts#setDepartmentConfig": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/configuration.ts#setFacilityConfig": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/configuration.ts#setOrgConfig": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/facilities.ts#createFacility": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/facilities.ts#transitionFacility": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/facilities.ts#updateFacility": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/memberships.ts#addFacilityMembership": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/memberships.ts#addOrganizationMembership": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/memberships.ts#removeFacilityMembership": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/memberships.ts#removeOrganizationMembership": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/memberships.ts#setFacilityMembershipScope": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/memberships.ts#setOrganizationMembershipScope": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/organizations.ts#createOrganization": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/organizations.ts#transitionOrganization": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/organizations.ts#updateOrganization": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/enterprise/provisioning.ts#provisionOrganization": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/events/dispatcher.ts#dispatchPendingDomainEvents": { category: "BOOKKEEPING", reason: "event/audit infrastructure (outbox claims and delivery ledger); found by the extended rule (batch 4)" },
  "src/lib/events/dispatcher.ts#reapStaleClaims": { category: "BOOKKEEPING", reason: "event/audit infrastructure" },
  "src/lib/events/emit.ts#emitDomainEvent": { category: "BOOKKEEPING", reason: "event/audit infrastructure" },
  "src/lib/events/replay.ts#replayEvent": { category: "BOOKKEEPING", reason: "event/audit infrastructure" },
  "src/lib/events/replay.ts#retryDeadLetter": { category: "BOOKKEEPING", reason: "event/audit infrastructure" },
  "src/lib/hospital/admission.ts#completeBedCleaning": { category: "OPERATIONAL_DETAIL", reason: "bed housekeeping state; patient moves are their own events" },
  "src/lib/hospital/admission.ts#updateDischargeReadiness": { category: "CONSUMER_OUTPUT", reason: "written by the discharge-readiness consumer; readiness is derived from events" },
  "src/lib/hospital/bed.ts#transitionBed": { category: "OPERATIONAL_DETAIL", reason: "bed status; patient placement is PatientTransferred / AdmissionCreated" },
  "src/lib/hospital/billing/adjustments.ts#createAdjustment": { category: "PROCESS_STEP", reason: "adjustment request awaiting approval", boundary: ["BillingAdjustmentStatusChanged"] },
  "src/lib/hospital/billing/billingAccount.ts#getOrCreateBillingAccount": { category: "BOOKKEEPING", reason: "derived balance / get-or-create helper called inside a larger operation" },
  "src/lib/hospital/billing/coverage.ts#createPayer": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/billing/coverage.ts#createPayerPlan": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/billing/invoices.ts#addChargeToInvoice": { category: "PROCESS_STEP", reason: "edit to a draft invoice", boundary: ["HospitalInvoiceIssued", "HospitalInvoiceVoided"] },
  "src/lib/hospital/billing/invoices.ts#draftInvoiceForAccount": { category: "PROCESS_STEP", reason: "draft invoice; money moves on HospitalInvoiceIssued", boundary: ["HospitalInvoiceIssued", "HospitalInvoiceVoided"] },
  "src/lib/hospital/billing/invoices.ts#draftSupplementaryInvoice": { category: "PROCESS_STEP", reason: "draft supplementary invoice or debit note; money moves when it is issued", boundary: ["HospitalInvoiceIssued", "HospitalInvoiceVoided"] },
  "src/lib/hospital/billing/invoices.ts#refreshInvoicePaymentStatus": { category: "BOOKKEEPING", reason: "derived status, decision log or provenance written as part of another operation" },
  "src/lib/hospital/billing/invoices.ts#syncDraftLineForCharge": { category: "BOOKKEEPING", reason: "keeps a draft invoice line in step inside priceCharge/waiveCharge, whose events cover it" },
  "src/lib/hospital/billing/packages.ts#createPackageDefinition": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/billing/pricing.ts#createTariff": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/billing/pricing.ts#deactivateTariff": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/billing/refunds.ts#approveRefund": { category: "PROCESS_STEP", reason: "approval step; money moves on completion", boundary: ["HospitalRefundStatusChanged"] },
  "src/lib/hospital/billing/refunds.ts#requestRefund": { category: "PROCESS_STEP", reason: "refund request; money moves on completion", boundary: ["HospitalRefundStatusChanged"] },
  "src/lib/hospital/billing/sequence.ts#nextSequence": { category: "BOOKKEEPING", reason: "number sequence" },
  "src/lib/hospital/blood.ts#createBloodProduct": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/blood.ts#recordCompatibility": { category: "PROCESS_STEP", reason: "crossmatch entry; verification is the event", boundary: ["BloodCompatibilityRecorded"] },
  "src/lib/hospital/blood.ts#recordUnitTyping": { category: "PROCESS_STEP", reason: "lab check on a unit; releasing the unit is the event", boundary: ["BloodUnitStatusChanged"] },
  "src/lib/hospital/clinicalSafety.ts#writeSafetyWarnings": { category: "BOOKKEEPING", reason: "derived status, decision log or provenance written as part of another operation" },
  "src/lib/hospital/diagnosticsAdvanced.ts#recordStudyAcquisition": { category: "PROCESS_STEP", reason: "acquisition metadata; ImagingStudyCompleted is the event", boundary: ["ImagingStudyCompleted"] },
  "src/lib/hospital/diagnosticsAdvanced.ts#setSpecimenIdentity": { category: "PROCESS_STEP", reason: "labelling check inside collection; SpecimenCollected is the event", boundary: ["SpecimenCollected"] },
  "src/lib/hospital/icu.ts#createIcuUnit": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/imagingReportLifecycle.ts#enterReport": { category: "PROCESS_STEP", reason: "unverified report; ImagingReportReleased is the event", boundary: ["ImagingReportReleased"] },
  "src/lib/hospital/interoperability/abdm/callbacks.ts#receiveCallback": { category: "INTEGRATION_PROTOCOL", reason: "inbound ABDM callback log; the state changes it causes emit their own events" },
  "src/lib/hospital/interoperability/abdm/client.ts#recordProtocolTransition": { category: "BOOKKEEPING", reason: "derived status, decision log or provenance written as part of another operation" },
  "src/lib/hospital/interoperability/controlPlane/alerts.ts#raiseAlert": { category: "OPERATIONAL_DETAIL", reason: "integration health alert for operators" },
  "src/lib/hospital/interoperability/controlPlane/alerts.ts#resolveAlertsByType": { category: "OPERATIONAL_DETAIL", reason: "integration health alert for operators" },
  "src/lib/hospital/interoperability/controlPlane/alerts.ts#transitionAlert": { category: "OPERATIONAL_DETAIL", reason: "integration health alert for operators" },
  "src/lib/hospital/interoperability/controlPlane/certificates.ts#activateNextCertificate": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/hospital/interoperability/controlPlane/certificates.ts#registerCertificate": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/hospital/interoperability/controlPlane/certificates.ts#sweepCertificates": { category: "BOOKKEEPING", reason: "derived status, decision log or provenance written as part of another operation" },
  "src/lib/hospital/interoperability/controlPlane/configuration.ts#approveProduction": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/hospital/interoperability/controlPlane/configuration.ts#configureIntegration": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/hospital/interoperability/controlPlane/configuration.ts#rollbackConfiguration": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/hospital/interoperability/controlPlane/killSwitch.ts#disableIntegration": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/hospital/interoperability/controlPlane/killSwitch.ts#enableIntegration": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/hospital/interoperability/controlPlane/participants.ts#registerParticipant": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/interoperability/controlPlane/participants.ts#setParticipantTrust": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/interoperability/fhir/import.ts#importFhirPayload": { category: "PROCESS_STEP", reason: "stages inbound resources for review; the record changes only when one is accepted (ImportedResourceReviewed)", boundary: ["ImportedResourceReviewed"] },
  "src/lib/hospital/interoperability/provenance.ts#recordProvenance": { category: "BOOKKEEPING", reason: "derived status, decision log or provenance written as part of another operation" },
  "src/lib/hospital/interoperability/terminology.ts#createTerminologyMapping": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/interoperability/terminology.ts#retireTerminologyMapping": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/inventory/inventoryAdvanced.ts#createDepartmentRequest": { category: "PROCESS_STEP", reason: "department request; stock moves when it is fulfilled", boundary: ["SupplyRequestStatusChanged"] },
  "src/lib/hospital/inventory/itemMedicationLink.ts#linkMedicationToItem": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/inventory/items.ts#createItem": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/inventory/items.ts#updateItem": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/inventory/locations.ts#createStockLocation": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/inventory/locations.ts#updateStockLocation": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/inventory/lots.ts#getOrCreateLot": { category: "BOOKKEEPING", reason: "derived balance / get-or-create helper called inside a larger operation" },
  "src/lib/hospital/inventory/stockBalance.ts#atomicConvertReservedToIssued": { category: "BOOKKEEPING", reason: "derived balance / get-or-create helper called inside a larger operation" },
  "src/lib/hospital/inventory/stockBalance.ts#atomicDecrementOnHand": { category: "BOOKKEEPING", reason: "derived balance / get-or-create helper called inside a larger operation" },
  "src/lib/hospital/inventory/stockBalance.ts#atomicDecrementReserved": { category: "BOOKKEEPING", reason: "derived balance / get-or-create helper called inside a larger operation" },
  "src/lib/hospital/inventory/stockBalance.ts#atomicIncrementOnHand": { category: "BOOKKEEPING", reason: "derived balance / get-or-create helper called inside a larger operation" },
  "src/lib/hospital/inventory/stockBalance.ts#atomicIncrementReserved": { category: "BOOKKEEPING", reason: "derived balance / get-or-create helper called inside a larger operation" },
  "src/lib/hospital/inventory/stockBalance.ts#getOrCreateStockBalance": { category: "BOOKKEEPING", reason: "derived balance / get-or-create helper called inside a larger operation" },
  "src/lib/hospital/inventory/stocktake.ts#addStockTakeLine": { category: "PROCESS_STEP", reason: "count in progress", boundary: ["StockDocumentStatusChanged"] },
  "src/lib/hospital/inventory/stocktake.ts#startStockTake": { category: "PROCESS_STEP", reason: "count in progress; variances move stock on completion", boundary: ["StockDocumentStatusChanged"] },
  "src/lib/hospital/labOrder.ts#markEncounterInvestigating": { category: "BOOKKEEPING", reason: "encounter status step taken inside the order's own transaction; the order event covers it" },
  "src/lib/hospital/labResultLifecycle.ts#enterResult": { category: "PROCESS_STEP", reason: "unverified entry; LabResultReleased is the event", boundary: ["LabResultReleased"] },
  "src/lib/hospital/medicationSchedule.ts#generateAdministrationSchedule": { category: "CONSUMER_OUTPUT", reason: "becomes the mar-scheduler consumer's write (reacting to MedicationVerified)" },
  "src/lib/hospital/nhcx/callbacks.ts#receiveCallback": { category: "INTEGRATION_PROTOCOL", reason: "inbound NHCX callback log; the changes it causes emit their own events" },
  "src/lib/hospital/nhcx/submission.ts#buildSubmission": { category: "PROCESS_STEP", reason: "builds the package; ClaimSubmitted is the event", boundary: ["ClaimSubmitted"] },
  "src/lib/hospital/nhcx/submission.ts#retryExchange": { category: "INTEGRATION_PROTOCOL", reason: "protocol retry of an exchange" },
  "src/lib/hospital/nhcx/submission.ts#syncCanonicalClaimStatus": { category: "BOOKKEEPING", reason: "derived status, decision log or provenance written as part of another operation" },
  "src/lib/hospital/nhcx/submission.ts#transitionExchange": { category: "INTEGRATION_PROTOCOL", reason: "protocol state of an exchange; the claim's status change is its own event" },
  "src/lib/hospital/notifications.ts#createNotification": { category: "BOOKKEEPING", reason: "notifications are an output of reactions, not a domain fact" },
  "src/lib/hospital/notifications.ts#createNotifications": { category: "BOOKKEEPING", reason: "notifications are an output of reactions, not a domain fact" },
  "src/lib/hospital/notifications.ts#markAllRead": { category: "BOOKKEEPING", reason: "notifications are an output of reactions, not a domain fact" },
  "src/lib/hospital/notifications.ts#markRead": { category: "BOOKKEEPING", reason: "notifications are an output of reactions, not a domain fact" },
  "src/lib/hospital/nursingAssessment.ts#createAssessment": { category: "PROCESS_STEP", reason: "draft; the record changes when it is completed or signed", boundary: ["NursingAssessmentRecorded"] },
  "src/lib/hospital/operations/service.ts#createAmbulance": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/operations/service.ts#createAmbulanceTrip": { category: "OPERATIONAL_DETAIL", reason: "fleet logistics" },
  "src/lib/hospital/operations/service.ts#createEquipment": { category: "REFERENCE_DATA", reason: "equipment register entry" },
  "src/lib/hospital/operations/service.ts#createHousekeepingRequest": { category: "OPERATIONAL_DETAIL", reason: "housekeeping logistics" },
  "src/lib/hospital/operations/service.ts#createTransportRequest": { category: "OPERATIONAL_DETAIL", reason: "porter/transport logistics; location changes are their own events" },
  "src/lib/hospital/operations/service.ts#dispatchAmbulanceTrip": { category: "OPERATIONAL_DETAIL", reason: "fleet logistics" },
  "src/lib/hospital/operations/service.ts#moveEquipment": { category: "OPERATIONAL_DETAIL", reason: "equipment location" },
  "src/lib/hospital/operations/service.ts#planMeal": { category: "OPERATIONAL_DETAIL", reason: "kitchen meal planning" },
  "src/lib/hospital/operations/service.ts#schedulePreventiveMaintenance": { category: "OPERATIONAL_DETAIL", reason: "maintenance schedule" },
  "src/lib/hospital/operations/service.ts#setAmbulanceStatus": { category: "OPERATIONAL_DETAIL", reason: "fleet logistics" },
  "src/lib/hospital/operations/service.ts#transitionAmbulanceTrip": { category: "OPERATIONAL_DETAIL", reason: "fleet logistics" },
  "src/lib/hospital/operations/service.ts#transitionHousekeeping": { category: "OPERATIONAL_DETAIL", reason: "housekeeping logistics" },
  "src/lib/hospital/operations/service.ts#transitionMeal": { category: "OPERATIONAL_DETAIL", reason: "meal delivery logistics" },
  "src/lib/hospital/operations/service.ts#transitionTransport": { category: "OPERATIONAL_DETAIL", reason: "porter/transport logistics" },
  "src/lib/hospital/orderEnvelope.ts#createOrderEnvelope": { category: "BOOKKEEPING", reason: "Order envelope maintained inside the specific order's transaction (D9)" },
  "src/lib/hospital/orderEnvelope.ts#syncOrderStatus": { category: "BOOKKEEPING", reason: "Order envelope maintained inside the specific order's transaction (D9)" },
  "src/lib/hospital/pharmacy.ts#addFormularyEntry": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/pharmacy.ts#createMedicationReturn": { category: "PROCESS_STEP", reason: "a return awaiting classification; stock moves on classification", boundary: ["StockMoved"] },
  "src/lib/hospital/pharmacy.ts#createPharmacyRequest": { category: "PROCESS_STEP", reason: "ward request; stock moves when it is fulfilled", boundary: ["SupplyRequestStatusChanged"] },
  "src/lib/hospital/pharmacy.ts#deactivateFormularyEntry": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/pharmacy.ts#updateMedicationMaster": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/procurement/goodsReceipts.ts#assignGoodsReceiptNumber": { category: "BOOKKEEPING", reason: "number sequence" },
  "src/lib/hospital/procurement/goodsReceipts.ts#recordGoodsReceipt": { category: "PROCESS_STEP", reason: "receipt awaiting approval; GoodsReceived on approval", boundary: ["GoodsReceived", "StockDocumentStatusChanged"] },
  "src/lib/hospital/procurement/procurementAdvanced.ts#createRfq": { category: "OPERATIONAL_DETAIL", reason: "sourcing; money is committed by the purchase order (PurchaseOrderStatusChanged)" },
  "src/lib/hospital/procurement/procurementAdvanced.ts#createSupplierContract": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/procurement/procurementAdvanced.ts#deactivateSupplierContract": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/procurement/procurementAdvanced.ts#recordQuotation": { category: "OPERATIONAL_DETAIL", reason: "sourcing; money is committed by the purchase order" },
  "src/lib/hospital/procurement/procurementAdvanced.ts#selectQuotation": { category: "OPERATIONAL_DETAIL", reason: "sourcing; money is committed by the purchase order" },
  "src/lib/hospital/procurement/procurementAdvanced.ts#transitionRfq": { category: "OPERATIONAL_DETAIL", reason: "sourcing; money is committed by the purchase order" },
  "src/lib/hospital/procurement/purchaseOrders.ts#addPurchaseOrderLine": { category: "PROCESS_STEP", reason: "line on a draft purchase order; money is committed on approval", boundary: ["PurchaseOrderStatusChanged"] },
  "src/lib/hospital/procurement/purchaseOrders.ts#createPurchaseOrderDraft": { category: "PROCESS_STEP", reason: "draft purchase order; money is committed on approval", boundary: ["PurchaseOrderStatusChanged"] },
  "src/lib/hospital/procurement/purchaseOrders.ts#markSent": { category: "PROCESS_STEP", reason: "PO dispatch step", boundary: ["PurchaseOrderStatusChanged"] },
  "src/lib/hospital/procurement/purchaseOrders.ts#recomputeReceivingStatus": { category: "BOOKKEEPING", reason: "derived status, decision log or provenance written as part of another operation" },
  "src/lib/hospital/procurement/purchaseOrders.ts#submitForApproval": { category: "PROCESS_STEP", reason: "PO approval step", boundary: ["PurchaseOrderStatusChanged"] },
  "src/lib/hospital/procurement/requisitions.ts#addRequisitionLine": { category: "OPERATIONAL_DETAIL", reason: "internal requisition" },
  "src/lib/hospital/procurement/requisitions.ts#approveRequisition": { category: "OPERATIONAL_DETAIL", reason: "internal requisition; it becomes a purchase order" },
  "src/lib/hospital/procurement/requisitions.ts#cancelRequisition": { category: "OPERATIONAL_DETAIL", reason: "internal requisition; no money, stock or care changes" },
  "src/lib/hospital/procurement/requisitions.ts#createRequisitionDraft": { category: "OPERATIONAL_DETAIL", reason: "internal requisition; money is committed by the purchase order" },
  "src/lib/hospital/procurement/requisitions.ts#rejectRequisition": { category: "OPERATIONAL_DETAIL", reason: "internal requisition; no money, stock or care changes" },
  "src/lib/hospital/procurement/requisitions.ts#reviseApprovedRequisition": { category: "OPERATIONAL_DETAIL", reason: "internal requisition" },
  "src/lib/hospital/procurement/requisitions.ts#submitRequisition": { category: "OPERATIONAL_DETAIL", reason: "internal requisition" },
  "src/lib/hospital/procurement/sequence.ts#nextGoodsReceiptSequence": { category: "BOOKKEEPING", reason: "number sequence" },
  "src/lib/hospital/procurement/sequence.ts#nextPurchaseOrderSequence": { category: "BOOKKEEPING", reason: "number sequence" },
  "src/lib/hospital/procurement/sequence.ts#nextPurchaseRequisitionSequence": { category: "BOOKKEEPING", reason: "number sequence" },
  "src/lib/hospital/procurement/suppliers.ts#createSupplier": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/procurement/suppliers.ts#updateSupplier": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/quality/service.ts#addMeasure": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/quality/service.ts#attachEvidence": { category: "OPERATIONAL_DETAIL", reason: "compliance evidence attachment" },
  "src/lib/hospital/quality/service.ts#createAudit": { category: "OPERATIONAL_DETAIL", reason: "audit scheduling" },
  "src/lib/hospital/quality/service.ts#createRca": { category: "PROCESS_STEP", reason: "root-cause analysis draft", boundary: ["QualityIncidentStatusChanged"] },
  "src/lib/hospital/quality/service.ts#createStandard": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/quality/service.ts#transitionAudit": { category: "OPERATIONAL_DETAIL", reason: "audit progress; its findings are the events" },
  "src/lib/hospital/quality/service.ts#updateRca": { category: "PROCESS_STEP", reason: "root-cause analysis draft", boundary: ["QualityIncidentStatusChanged"] },
  "src/lib/hospital/queue.ts#callNext": { category: "OPERATIONAL_DETAIL", reason: "queue token state, deliberately not an event (§1.2: QueueTokenCalled)" },
  "src/lib/hospital/queue.ts#cancelQueueEntry": { category: "OPERATIONAL_DETAIL", reason: "queue token state, deliberately not an event (§1.2)" },
  "src/lib/hospital/queue.ts#completeQueueEntry": { category: "OPERATIONAL_DETAIL", reason: "queue token state, deliberately not an event (§1.2)" },
  "src/lib/hospital/queue.ts#enterQueue": { category: "OPERATIONAL_DETAIL", reason: "queue token state, deliberately not an event (§1.2)" },
  "src/lib/hospital/queue.ts#recomputeQueuePriority": { category: "BOOKKEEPING", reason: "derived status, decision log or provenance written as part of another operation" },
  "src/lib/hospital/queue.ts#skipQueueEntry": { category: "OPERATIONAL_DETAIL", reason: "queue token state, deliberately not an event (§1.2)" },
  "src/lib/hospital/queue.ts#startService": { category: "OPERATIONAL_DETAIL", reason: "queue token state, deliberately not an event (§1.2)" },
  "src/lib/hospital/specimenLifecycle.ts#acceptSpecimen": { category: "PROCESS_STEP", reason: "lab receipt step between collection and result", boundary: ["LabResultReleased", "SpecimenStatusChanged"] },
  "src/lib/hospital/specimenLifecycle.ts#accessionSpecimen": { category: "BOOKKEEPING", reason: "runs inside placeLabOrder's transaction; LabOrderPlaced covers it" },
  "src/lib/hospital/surgery.ts#createOperatingTheatre": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/surgery.ts#createProcedure": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/surgery.ts#ensureChecklist": { category: "BOOKKEEPING", reason: "derived status, decision log or provenance written as part of another operation" },
  "src/lib/hospital/surgery.ts#setTeamMember": { category: "OPERATIONAL_DETAIL", reason: "theatre team roster for the case" },
  "src/lib/hospital/workforce/service.ts#cancelShift": { category: "OPERATIONAL_DETAIL", reason: "roster entry; bookability reads it directly" },
  "src/lib/hospital/workforce/service.ts#createShift": { category: "OPERATIONAL_DETAIL", reason: "roster entry; bookability reads it directly" },
  "src/lib/hospital/workforce/service.ts#createStaffingRequirement": { category: "REFERENCE_DATA", reason: "catalogue / master data; no runtime reaction depends on it" },
  "src/lib/hospital/workforce/service.ts#setAvailability": { category: "OPERATIONAL_DETAIL", reason: "staff availability (StaffAbsence); bookability reads it directly" },
  "src/lib/patient/experience/family.ts#inviteDelegate": { category: "PROCESS_STEP", reason: "an invitation grants nothing; access starts on acceptance (FamilyAccessGranted)", boundary: ["FamilyAccessGranted"] },
  "src/lib/scoring/achievements.ts#grantEarnedAchievements": { category: "BOOKKEEPING", reason: "Scholar scoring projection" },
  "src/lib/scoring/competencies.ts#updateCompetencies": { category: "BOOKKEEPING", reason: "Scholar scoring projection" },
  "src/lib/verification/migrateLegacy.ts#migrateLegacyVerificationUploads": { category: "BOOKKEEPING", reason: "idempotent bootstrap / one-off migration" },
  "src/lib/workflow-builder/drafts.ts#deleteDraft": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/workflow-builder/drafts.ts#publishDraft": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/workflow-builder/drafts.ts#saveDraft": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/workflows/definitions.ts#createDefinition": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/workflows/definitions.ts#createVersion": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/workflows/definitions.ts#publishVersion": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/workflows/definitions.ts#retireDefinition": { category: "CONFIGURATION", reason: "tenant, configuration or integration administration" },
  "src/lib/workflows/timers.ts#cancelInstanceTimersTx": { category: "BOOKKEEPING", reason: "workflow-engine state (instances, steps, timers); the engine is itself driven by events" },
  "src/lib/workflows/timers.ts#createTimerTx": { category: "BOOKKEEPING", reason: "workflow-engine state (instances, steps, timers); the engine is itself driven by events" },
};

/**
 * Functions that already emit an event (so the rule above is satisfied) but
 * still owe a catalogued event of their own at a later spine step. The entry is
 * stale, and fails the test, once the function emits that event.
 */
export const OWED_EVENTS: Record<string, { event: string; step: number }> = {
  // Empty since step 6 (placeLabOrder, placeImagingOrder and addIntervention now emit theirs).
};

/**
 * Route handlers that write domain tables directly instead of through a
 * service function (§6 rule 4). Must shrink to zero; step 3 removes patient
 * registration, encounter creation and lab/imaging order placement.
 */
export const ROUTE_WRITE_ALLOWLIST: readonly string[] = [
  // Empty since batch 7: every route-level write moved into a service.
];
