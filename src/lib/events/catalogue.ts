import { z } from "zod";
import type { EventContract } from "./types";
import { PERSON_SOURCES, PERSON_LINK_METHODS } from "@/lib/person/vocab";

/**
 * Phase D6 — the event catalogue (in-code schema registry).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Every domain event Aarogya can emit is declared HERE, exactly once, with a
 * versioned, `.strict()` payload contract. This is the single source of truth for:
 *   - which event types + versions are legal (unknown ones are rejected on emit
 *     AND on dispatch/replay — see emit.ts / dispatcher.ts);
 *   - the payload shape (identifiers + minimal metadata only, never PHI/secrets);
 *   - the aggregate, tenant scope, sensitivity, and producing service.
 *
 * Events are CONTRACTS. Never change the meaning of an existing version — add a
 * new version (e.g. PatientRegistered v2) and keep v1. Consumers declare the
 * version they understand. The catalogue is keyed by `${type}@${version}`.
 * ════════════════════════════════════════════════════════════════════════════
 */

// Reusable field helpers. Identifiers are non-empty strings; money is integer
// minor units + an ISO-4217 code (currency is never summed across events).
const id = z.string().min(1);
const optId = z.string().min(1).optional();
const minor = z.number().int();
const currency = z.string().length(3);
const iso = z.string().min(1); // ISO-8601 timestamp string
// Closed sets mirrored from the Prisma enums they describe.
const orderPriority = z.enum(["ROUTINE", "URGENT", "STAT"]);
const medicationOrderStatus = z.enum(["DRAFT", "ORDERED", "PHARMACY_REVIEW", "HELD", "REJECTED", "VERIFIED", "DISPENSED", "ACTIVE", "COMPLETED", "CANCELLED", "DISCONTINUED"]);
const externalLabStatus = z.enum(["DRAFT", "SENT", "RESULT_RECEIVED", "REVIEWED", "CANCELLED"]);
const lotStatus = z.enum(["ACTIVE", "QUARANTINED", "EXPIRED", "RECALLED", "DEPLETED"]);
const icuDeviceStatus = z.enum(["PLANNED", "ACTIVE", "REMOVED", "DISCONTINUED"]);
const icuInfusionStatus = z.enum(["RUNNING", "PAUSED", "STOPPED"]);
const delegationScope = z.enum(["APPOINTMENTS", "RECORDS", "REPORTS", "PRESCRIPTIONS", "MEDICATIONS", "BILLING", "INSURANCE", "CONSENT"]);
const accessSessionStatus = z.enum(["PENDING", "ACTIVE", "ENDED", "EXPIRED", "CANCELLED"]);
const shareKind = z.enum(["CODE", "REQUEST"]);
const shareStatus = z.enum(["PENDING", "ACTIVE", "ENDED", "EXPIRED", "REVOKED"]);
// Widened in v1 before the 4c events ever shipped to main (PR #7 unmerged): no consumer has seen v1.
const shareCategory = z.enum(["PRESCRIPTIONS", "LABS", "IMAGING", "DISCHARGE_SUMMARIES", "UPLOADS", "CONDITIONS", "VITALS", "CLINICAL_NOTES"]);
const sharePurpose = z.enum(["CONSULTATION", "SECOND_OPINION", "FOLLOW_UP", "REFERRAL", "OTHER"]);
const shareEndReason = z.enum(["VISIT_ENDED", "EXPIRED", "PATIENT_ENDED", "REVOKE_ALL", "PERSON_CLOSED"]);
const accessRequestStatus = z.enum(["REQUESTED", "APPROVED", "DECLINED", "CANCELLED", "EXPIRED"]);
const sensitiveCategory = z.enum(["MENTAL_HEALTH", "SEXUAL_HEALTH", "HIV", "SUBSTANCE_USE", "REPRODUCTIVE_HEALTH"]);
const resuscitationStatus = z.enum(["ACTIVATED", "ACTIVE", "STABILIZED", "HANDED_OVER", "DISPOSITION_PENDING", "CLOSED"]);
const surgeryStatus = z.enum(["REQUESTED", "REVIEWED", "APPROVED", "SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);
const recoveryStatus = z.enum(["PENDING", "IN_RECOVERY", "READY_FOR_TRANSFER", "TRANSFERRED"]);
const bloodUnitStatus = z.enum(["AVAILABLE", "RESERVED", "ISSUED", "IN_TRANSIT", "TRANSFUSING", "TRANSFUSED", "RETURNED", "WASTED", "QUARANTINED", "EXPIRED", "DISCARDED"]);
const bloodRequestStatus = z.enum(["REQUESTED", "REVIEWED", "APPROVED", "COMPATIBILITY_PENDING", "READY", "ISSUED", "COMPLETED", "CANCELLED", "REJECTED"]);
const transfusionStatus = z.enum(["RECEIVED", "IN_PROGRESS", "PAUSED", "COMPLETED", "STOPPED"]);
const transfusionReactionStatus = z.enum(["REPORTED", "UNDER_REVIEW", "ESCALATED", "RESOLVED"]);
const transferRequestStatus = z.enum(["REQUESTED", "ACCEPTED", "BED_RESERVED", "PATIENT_IN_TRANSIT", "COMPLETED", "CANCELLED", "REJECTED"]);
const invoiceStatus = z.enum(["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "VOID"]);
const invoiceDocumentType = z.enum(["INVOICE", "SUPPLEMENTARY_INVOICE", "DEBIT_NOTE"]);
const paymentStatus = z.enum(["RECEIVED", "VOIDED"]);
const paymentMethod = z.enum(["CASH", "CARD", "UPI", "NETBANKING", "CHEQUE", "INSURANCE_SETTLEMENT"]);
const refundStatus = z.enum(["REQUESTED", "APPROVED", "REJECTED", "COMPLETED"]);
const adjustmentStatus = z.enum(["PENDING", "APPROVED", "REJECTED"]);
const adjustmentType = z.enum(["CREDIT_NOTE", "DEBIT_NOTE", "WRITE_OFF", "DISCOUNT"]);
const claimStatus = z.enum(["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "PARTIALLY_APPROVED", "REJECTED", "SETTLED", "CLOSED"]);
const preAuthStatus = z.enum(["REQUESTED", "APPROVED", "DENIED", "EXPIRED"]);
const coverageStatus = z.enum(["ACTIVE", "INACTIVE", "EXPIRED"]);
const claimQueryStatus = z.enum(["RECEIVED", "UNDER_REVIEW", "RESPONSE_DRAFT", "RESPONSE_SUBMITTED", "ACKNOWLEDGED", "RESOLVED", "CLOSED"]);
const claimExceptionStatus = z.enum(["OPEN", "ACKNOWLEDGED", "RESOLVED", "DISMISSED"]);
const claimExceptionType = z.enum(["AMOUNT_MISMATCH", "MISSING_SETTLEMENT", "DUPLICATE_SETTLEMENT", "OVERPAYMENT", "UNDERPAYMENT", "ORPHAN_EXTERNAL_REFERENCE", "UNMATCHED_CLAIM", "STALE_EXTERNAL_STATUS"]);
const alertSeverity = z.enum(["INFO", "WARNING", "CRITICAL"]);
const billingCreditStatus = z.enum(["ACTIVE", "APPLIED", "VOID"]);
const billingCreditType = z.enum(["PROMOTIONAL", "MANUAL", "CORRECTION", "CONTRACT"]);
const billingInvoiceStatus = z.enum(["DRAFT", "OPEN", "PARTIALLY_PAID", "PAID", "PAST_DUE", "VOID", "UNCOLLECTIBLE"]);
const subscriptionStatus = z.enum(["TRIAL", "ACTIVE", "PAST_DUE", "GRACE", "SUSPENDED", "CANCELLED", "EXPIRED"]);
const personLinkMethod = z.enum(PERSON_LINK_METHODS);
// Week 4a — the document pipeline's closed codes.
const documentLanguage = z.enum(["en", "hi", "mr", "ta", "bn", "gu", "te", "kn", "ml", "mixed", "und"]);
// Week 4b: Odia and Urdu join the pipeline (the app's eleven languages).
const documentLanguageV2 = z.enum(["en", "hi", "mr", "ta", "bn", "gu", "te", "kn", "ml", "or", "ur", "mixed", "und"]);
const confidenceBand = z.enum(["HIGH", "MEDIUM", "LOW"]);
const documentStep = z.enum(["PAGE_SPLIT", "OCR", "TRANSLATE", "EXTRACT", "MERGE"]);
const extractedFactType = z.enum(["DOCUMENT_META", "DIAGNOSIS", "MEDICATION", "LAB_VALUE", "PROCEDURE", "ALLERGY"]);
const patientProvidedKind = z.enum(["DIAGNOSIS", "MEDICATION_HISTORY", "LAB_RESULT", "PROCEDURE", "ALLERGY"]);
const allergyStatusAssertion = z.enum(["NO_KNOWN_ALLERGIES", "UNKNOWN", "HAS_ALLERGIES"]);
const documentStepError = z.enum(["PROVIDER_UNAVAILABLE", "RATE_LIMITED", "UNREADABLE", "UNSUPPORTED_LANGUAGE", "EXACT_COPY_VIOLATION", "TOO_LARGE", "INTERNAL"]);

function contract<P extends z.ZodTypeAny>(c: EventContract<P>): EventContract<P> {
  return c;
}

/**
 * The catalogue. Grouped by domain. Keep payloads minimal — a consumer that needs
 * the full record must load it through the normal authorized APIs.
 */
export const EVENT_CONTRACTS: EventContract[] = [
  // ── Clinical ───────────────────────────────────────────────────────────────
  contract({
    type: "PatientRegistered", version: 1, aggregateType: "PATIENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "patient registration",
    payload: z.object({ patientId: id, uhid: optId }).strict(),
  }),
  contract({
    type: "AppointmentBooked", version: 1, aggregateType: "APPOINTMENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "scheduling (bookAppointment)",
    payload: z.object({ appointmentId: id, patientId: id, doctorStaffId: id, scheduledStart: iso }).strict(),
  }),
  contract({
    type: "AdmissionCreated", version: 1, aggregateType: "ADMISSION", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "admissions (admitPatient)",
    payload: z.object({ admissionId: id, encounterId: id, patientId: id, bedId: optId }).strict(),
  }),
  // ── ADT, scheduling and ED (workflow spine §1.2 #19–30, #62) ─────────────
  contract({
    type: "EncounterOpened", version: 1, aggregateType: "ENCOUNTER", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "encounters (openEncounter)",
    payload: z.object({ encounterId: id, patientId: id, encounterType: id, accessSource: optId }).strict(),
  }),
  contract({
    type: "EdArrivalRegistered", version: 1, aggregateType: "ENCOUNTER", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "emergency (registerEdArrival)",
    payload: z.object({ encounterId: id, patientId: id, arrivalMode: optId, traumaIndicator: z.boolean() }).strict(),
  }),
  contract({
    type: "PatientCheckedIn", version: 1, aggregateType: "APPOINTMENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "scheduling (checkInAppointment)",
    payload: z.object({ appointmentId: id, patientId: id, encounterId: optId }).strict(),
  }),
  contract({
    type: "AppointmentCancelled", version: 1, aggregateType: "APPOINTMENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "scheduling (cancelAppointment)",
    payload: z.object({ appointmentId: id, patientId: id, byPatient: z.boolean() }).strict(),
  }),
  contract({
    type: "PatientTriaged", version: 1, aggregateType: "ENCOUNTER", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "triage (recordTriage, COMPLETED only)",
    payload: z.object({ triageId: id, encounterId: id, patientId: id, acuity: z.number().int().min(1).max(5) }).strict(),
  }),
  contract({
    type: "AdmissionRequested", version: 1, aggregateType: "ADMISSION_REQUEST", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "admission requests (createAdmissionRequest)",
    payload: z.object({ admissionRequestId: id, encounterId: id, patientId: id, priority: id }).strict(),
  }),
  // ── ADT triage events (EVENT_TRIAGE.md step 4) ──────────────────────────
  contract({
    type: "AdmissionRequestStatusChanged", version: 1, aggregateType: "ADMISSION_REQUEST", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "admission requests (deferRequest, rejectRequest, cancelRequest, releaseReservation)",
    payload: z.object({
      admissionRequestId: id, encounterId: id, patientId: id,
      from: z.enum(["PENDING", "DEFERRED", "BED_RESERVED"]), to: z.enum(["PENDING", "DEFERRED", "REJECTED", "CANCELLED"]),
      /** A reservation given up by this change (release, or cancelling a reserved request). */
      releasedBedId: optId,
    }).strict(),
  }),
  contract({
    type: "AppointmentStatusChanged", version: 1, aggregateType: "APPOINTMENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "scheduling (confirmAppointment, markNoShow)",
    payload: z.object({
      appointmentId: id, patientId: id, doctorStaffId: id,
      from: z.enum(["REQUESTED", "CONFIRMED", "RESCHEDULED"]), to: z.enum(["CONFIRMED", "NO_SHOW"]),
    }).strict(),
  }),
  contract({
    type: "PatientLocationChanged", version: 1, aggregateType: "ENCOUNTER", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "emergency (assignEdLocation, releaseEdLocation)",
    payload: z.object({
      encounterId: id, patientId: id, change: z.enum(["ASSIGNED", "RELEASED"]),
      locationId: id, bedId: optId, releasedLocationId: optId,
    }).strict(),
  }),
  contract({
    type: "PatientMergeStatusChanged", version: 1, aggregateType: "PATIENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "patient merge (mergePatients, unmergePatients)",
    payload: z.object({ sourcePatientId: id, targetPatientId: id, action: z.enum(["MERGED", "UNMERGED"]), mergeRecordId: optId }).strict(),
  }),
  contract({
    type: "ResuscitationStatusChanged", version: 1, aggregateType: "ED_RESUSCITATION", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "emergency (activateResuscitation, updateResuscitation)",
    payload: z.object({
      resuscitationId: id, encounterId: id, patientId: id,
      from: resuscitationStatus.nullable(), to: resuscitationStatus,
    }).strict(),
  }),
  contract({
    type: "TransferRequestStatusChanged", version: 1, aggregateType: "TRANSFER_REQUEST", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "transfer requests (create, accept, reserve bed, in transit, complete, cancel)",
    payload: z.object({
      transferRequestId: id, admissionId: id, patientId: id, encounterId: id,
      from: transferRequestStatus.nullable(), to: transferRequestStatus,
      priority: z.enum(["ROUTINE", "URGENT", "EMERGENCY"]), reservedBedId: optId, transferId: optId,
    }).strict(),
  }),
  contract({
    type: "TaskCreated", version: 1, aggregateType: "TASK", scope: "ORGANIZATION",
    sensitivity: "INTERNAL", producer: "tasks (createTask: manual, care plan, order, event consumer, workflow)",
    payload: z.object({
      taskId: id, source: z.enum(["MANUAL", "CARE_PLAN", "WORKFLOW", "EVENT", "ORDER"]), taskType: id,
      priority: z.enum(["ROUTINE", "URGENT", "STAT"]), patientId: optId, encounterId: optId, dueAt: iso.optional(),
    }).strict(),
  }),
  contract({
    type: "TaskCompleted", version: 1, aggregateType: "TASK", scope: "ORGANIZATION",
    sensitivity: "INTERNAL", producer: "tasks (closeTask: completeTask, skipTask, workflow completion and cancellation, task-generator)",
    payload: z.object({ taskId: id, source: z.enum(["MANUAL", "CARE_PLAN", "WORKFLOW", "EVENT", "ORDER"]), outcome: z.enum(["COMPLETED", "CANCELLED"]) }).strict(),
  }),
  contract({
    type: "TaskUpdated", version: 1, aggregateType: "TASK", scope: "ORGANIZATION",
    sensitivity: "INTERNAL", producer: "tasks (updateTask: status between open states, owner, started)",
    payload: z.object({
      taskId: id, source: z.enum(["MANUAL", "CARE_PLAN", "WORKFLOW", "EVENT", "ORDER"]),
      changes: z.array(z.enum(["STATUS", "OWNER", "STARTED"])).min(1),
      fromStatus: z.enum(["OPEN", "ASSIGNED", "IN_PROGRESS"]), toStatus: z.enum(["OPEN", "ASSIGNED", "IN_PROGRESS"]),
      ownerStaffId: optId,
    }).strict(),
  }),
  contract({
    type: "TaskUpdated", version: 2, aggregateType: "TASK", scope: "ORGANIZATION",
    sensitivity: "INTERNAL", producer: "tasks (updateTask; escalateTask: workflow SLA escalation)",
    payload: z.object({
      taskId: id, source: z.enum(["MANUAL", "CARE_PLAN", "WORKFLOW", "EVENT", "ORDER"]),
      changes: z.array(z.enum(["STATUS", "OWNER", "STARTED", "PRIORITY", "ASSIGNED_ROLE"])).min(1),
      fromStatus: z.enum(["OPEN", "ASSIGNED", "IN_PROGRESS"]), toStatus: z.enum(["OPEN", "ASSIGNED", "IN_PROGRESS"]),
      ownerStaffId: optId, priority: orderPriority,
      /** True when a workflow SLA breach made the change. */
      escalated: z.boolean(),
    }).strict(),
  }),
  // ── Nursing (triage step 5b) ─────────────────────────────────────────────
  contract({
    type: "ClinicalHandoffStatusChanged", version: 1, aggregateType: "CLINICAL_HANDOFF", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "handoffs (createHandoff, acknowledgeHandoff)",
    payload: z.object({
      handoffId: id, patientId: id, encounterId: optId, handoffType: z.enum(["DOCTOR", "NURSE"]),
      urgency: z.enum(["ROUTINE", "URGENT", "EMERGENCY"]), escalationRequired: z.boolean(),
      from: z.enum(["PENDING"]).nullable(), to: z.enum(["PENDING", "ACKNOWLEDGED"]),
      fromStaffId: id, toStaffId: optId, acknowledgedByStaffId: optId,
    }).strict(),
  }),
  contract({
    type: "NurseAssignmentStatusChanged", version: 1, aggregateType: "NURSING_ASSIGNMENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "nurse assignment (assignNurse, endAssignment)",
    payload: z.object({
      assignmentId: id, patientId: id, encounterId: optId, nurseStaffId: id,
      from: z.enum(["ACTIVE"]).nullable(), to: z.enum(["ACTIVE", "ENDED"]),
      /** ENDED only: ended by hand, or by a reassignment of the patient. */
      endedBy: z.enum(["ENDED", "REASSIGNED"]).optional(),
    }).strict(),
  }),
  contract({
    type: "NursingAssessmentRecorded", version: 1, aggregateType: "NURSING_ASSESSMENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "nursing assessments (completeAssessment, signAssessment, amendAssessment)",
    payload: z.object({
      assessmentId: id, patientId: id, encounterId: id, nurseStaffId: id,
      stage: z.enum(["COMPLETED", "SIGNED", "AMENDED"]), version: z.number().int().min(1),
      /** AMENDED only: the signed assessment this one replaces. */
      supersedesAssessmentId: optId,
    }).strict(),
  }),
  contract({
    type: "BedReserved", version: 1, aggregateType: "ADMISSION_REQUEST", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "admission requests (allocateBed)",
    payload: z.object({ admissionRequestId: id, bedId: id, patientId: id }).strict(),
  }),
  contract({
    type: "PatientTransferred", version: 1, aggregateType: "ADMISSION", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "admissions (transferPatientInTx)",
    payload: z.object({ transferId: id, admissionId: id, encounterId: id, patientId: id, fromLocationId: optId, toLocationId: id }).strict(),
  }),
  contract({
    type: "IcuAdmitted", version: 1, aggregateType: "ADMISSION", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "ICU (admitToIcu, transferWithinIcu into an ICU bed)",
    payload: z.object({ admissionId: id, encounterId: id, patientId: id, icuUnitId: optId, viaTransfer: z.boolean() }).strict(),
  }),
  contract({
    type: "DischargeHoldChanged", version: 1, aggregateType: "DISCHARGE", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "discharge holds (placeDischargeHold, clearDischargeHold)",
    payload: z.object({
      holdId: id, dischargeId: id, admissionId: id, encounterId: id, patientId: id,
      change: z.enum(["PLACED", "CLEARED"]),
      reasonCode: z.enum(["BILLING", "INSURANCE", "CLINICAL", "DOCUMENTATION", "PHARMACY", "TRANSPORT", "PATIENT_REQUEST", "LEGAL", "OTHER"]),
    }).strict(),
  }),
  contract({
    type: "DischargeInitiated", version: 1, aggregateType: "DISCHARGE", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "admissions (initiateDischarge)",
    payload: z.object({ dischargeId: id, admissionId: id, encounterId: id, patientId: id }).strict(),
  }),
  contract({
    type: "PatientDischarged", version: 1, aggregateType: "DISCHARGE", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "admissions (finalizeDischarge)",
    payload: z.object({ dischargeId: id, admissionId: id, encounterId: id, patientId: id }).strict(),
  }),
  contract({
    type: "EncounterClosed", version: 1, aggregateType: "ENCOUNTER", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "encounter state machine (transitionEncounter, terminal status)",
    payload: z.object({ encounterId: id, patientId: id, toStatus: id }).strict(),
  }),
  contract({
    type: "EdDispositionDecided", version: 1, aggregateType: "ENCOUNTER", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "emergency (dispositionEncounter)",
    payload: z.object({ dispositionId: id, encounterId: id, patientId: id, dispositionType: id }).strict(),
  }),
  contract({
    type: "MedicationOrdered", version: 1, aggregateType: "MEDICATION_ORDER", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "medication lifecycle (createMedicationOrder)",
    payload: z.object({ orderId: id, patientId: id, encounterId: optId }).strict(),
  }),
  contract({
    type: "LabResultReleased", version: 1, aggregateType: "LAB_RESULT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "lab result lifecycle (verifyResult)",
    payload: z.object({ resultId: id, orderId: optId, patientId: optId, critical: z.boolean().optional() }).strict(),
  }),
  contract({
    type: "ImagingReportReleased", version: 1, aggregateType: "IMAGING_REPORT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "imaging report lifecycle (verifyReport)",
    payload: z.object({ reportId: id, studyId: optId, patientId: optId, critical: z.boolean().optional() }).strict(),
  }),

  // ── Orders, results, medication, pharmacy, ICU, care plans (spine §9 step 6) ─
  contract({
    type: "LabOrderPlaced", version: 1, aggregateType: "LAB_ORDER", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "lab orders (placeLabOrder)",
    payload: z.object({ labOrderId: id, orderId: id, encounterId: id, patientId: id, priority: orderPriority, catalogTestId: optId }).strict(),
  }),
  contract({
    type: "ImagingOrderPlaced", version: 1, aggregateType: "IMAGING_ORDER", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "imaging orders (placeImagingOrder)",
    payload: z.object({
      imagingOrderId: id, orderId: id, encounterId: id, patientId: id, priority: orderPriority,
      /** Closed by ImagingOrder_modality_check (migration 20261015100000_s8_clinical_enums). */
      modality: z.enum(["XRAY", "CT", "MRI", "USG", "MAMMOGRAPHY", "INTERVENTIONAL"]), catalogStudyId: optId,
    }).strict(),
  }),
  contract({
    type: "SpecimenCollected", version: 1, aggregateType: "SPECIMEN", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "specimens (collectSpecimen; surgical specimens at step 8)",
    payload: z.object({
      specimenId: id, patientId: id, encounterId: optId, specimenSource: z.enum(["LAB_ORDER", "SURGICAL"]),
      labOrderId: optId, surgeryId: optId,
    }).strict(),
  }),
  contract({
    type: "SpecimenStatusChanged", version: 1, aggregateType: "SPECIMEN", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "specimens (rejectSpecimen, recollectSpecimen)",
    payload: z.object({
      specimenId: id, labOrderId: id, patientId: id, encounterId: optId,
      from: z.enum(["COLLECTION_PENDING", "COLLECTED", "RECEIVED"]).nullable(), to: z.enum(["REJECTED", "COLLECTION_PENDING"]),
      rejectionReason: z.enum(["INSUFFICIENT_SPECIMEN", "WRONG_CONTAINER", "HEMOLYZED", "MISLABELED", "LEAKED", "EXPIRED_TRANSPORT", "INCORRECT_SPECIMEN_TYPE", "OTHER"]).optional(),
      /** A recollection: the rejected specimen this new one replaces. */
      recollectionOfSpecimenId: optId,
    }).strict(),
  }),
  contract({
    type: "SpecimenStatusChanged", version: 2, aggregateType: "SPECIMEN", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "specimens (receiveSpecimen, rejectSpecimen, recollectSpecimen)",
    payload: z.object({
      specimenId: id, labOrderId: id, patientId: id, encounterId: optId,
      from: z.enum(["COLLECTION_PENDING", "COLLECTED", "RECEIVED"]).nullable(), to: z.enum(["RECEIVED", "REJECTED", "COLLECTION_PENDING"]),
      rejectionReason: z.enum(["INSUFFICIENT_SPECIMEN", "WRONG_CONTAINER", "HEMOLYZED", "MISLABELED", "LEAKED", "EXPIRED_TRANSPORT", "INCORRECT_SPECIMEN_TYPE", "OTHER"]).optional(),
      recollectionOfSpecimenId: optId,
    }).strict(),
  }),
  contract({
    type: "ImagingStudyStatusChanged", version: 1, aggregateType: "IMAGING_STUDY", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "imaging studies (scheduleStudy, rescheduleStudy, cancelStudy)",
    payload: z.object({
      studyId: id, imagingOrderId: id, patientId: id, encounterId: id,
      from: z.enum(["SCHEDULED", "ARRIVED"]).nullable(), to: z.enum(["SCHEDULED", "CANCELLED"]), rescheduled: z.boolean(),
    }).strict(),
  }),
  contract({
    type: "ImagingStudyStatusChanged", version: 2, aggregateType: "IMAGING_STUDY", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "imaging studies (scheduleStudy, rescheduleStudy, checkInStudy, startStudy, cancelStudy)",
    payload: z.object({
      studyId: id, imagingOrderId: id, patientId: id, encounterId: id,
      from: z.enum(["SCHEDULED", "ARRIVED", "IN_PROGRESS"]).nullable(), to: z.enum(["SCHEDULED", "ARRIVED", "IN_PROGRESS", "CANCELLED"]), rescheduled: z.boolean(),
    }).strict(),
  }),
  contract({
    type: "ImagingStudyCompleted", version: 1, aggregateType: "IMAGING_STUDY", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "imaging studies (completeStudy)",
    payload: z.object({ studyId: id, imagingOrderId: id, patientId: id, encounterId: id }).strict(),
  }),
  contract({
    type: "CriticalResultAcknowledged", version: 1, aggregateType: "LAB_RESULT", alternateAggregateTypes: ["IMAGING_REPORT"], scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "lab results (acknowledgeResult), imaging reports (acknowledgeReport): critical only",
    payload: z.object({
      resultKind: z.enum(["LAB", "IMAGING"]), resultId: optId, reportId: optId, patientId: id,
      acknowledgedByStaffId: id, minutesToAcknowledge: z.number().int().min(0),
    }).strict(),
  }),
  contract({
    type: "DiagnosticReportAmended", version: 1, aggregateType: "LAB_RESULT", alternateAggregateTypes: ["IMAGING_REPORT"], scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "lab results (amendResult), imaging reports (amendReport)",
    payload: z.object({
      reportKind: z.enum(["LAB", "IMAGING"]), amendedId: id, supersedesId: id, orderId: id, patientId: id,
      version: z.number().int().min(2), critical: z.boolean(),
    }).strict(),
  }),
  contract({
    type: "ExternalLabReferralStatusChanged", version: 1, aggregateType: "EXTERNAL_LAB_REFERRAL", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "external lab referrals (createExternalReferral, transitionExternalReferral)",
    payload: z.object({
      referralId: id, patientId: id, encounterId: optId, labOrderId: optId,
      from: externalLabStatus.nullable(), to: externalLabStatus,
    }).strict(),
  }),
  contract({
    type: "MedicationVerified", version: 1, aggregateType: "MEDICATION_ORDER", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "medication lifecycle (verifyMedicationOrder)",
    payload: z.object({ orderId: id, patientId: id, encounterId: optId }).strict(),
  }),
  contract({
    type: "MedicationOrderStatusChanged", version: 1, aggregateType: "MEDICATION_ORDER", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "medication lifecycle (cancel, discontinue, hold, reject, requestClarification, resubmit)",
    payload: z.object({
      orderId: id, patientId: id, encounterId: optId, from: medicationOrderStatus, to: medicationOrderStatus,
      /** A hold that asks the prescriber for clarification. */
      clarificationRequested: z.boolean(),
      /** Future scheduled doses cancelled with a stop (discontinue, cancel). */
      cancelledDoseCount: z.number().int().min(0),
    }).strict(),
  }),
  contract({
    type: "MedicationDispensed", version: 1, aggregateType: "DISPENSING_RECORD", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "medication lifecycle (dispenseMedication), pharmacy (dispenseFromPharmacy, one per record)",
    payload: z.object({
      dispensingRecordId: id, orderId: id, patientId: id, encounterId: optId, quantity: z.number().positive(),
      partial: z.boolean(), dispenseGroupId: optId,
    }).strict(),
  }),
  contract({
    type: "MedicationAdministered", version: 1, aggregateType: "MEDICATION_ADMINISTRATION", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "medication lifecycle (administerMedication, status GIVEN)",
    payload: z.object({
      administrationId: id, orderId: id, patientId: id, encounterId: optId,
      /** A late recording: the swept MISSED dose this one documents. */
      lateForAdministrationId: optId,
    }).strict(),
  }),
  contract({
    type: "MedicationDoseMissed", version: 1, aggregateType: "MEDICATION_ADMINISTRATION", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "medication lifecycle (administerMedication, status MISSED), MAR sweep",
    payload: z.object({
      administrationId: id, orderId: id, patientId: id, encounterId: optId, scheduledAt: iso, missedBy: z.enum(["NURSE", "SWEEP"]),
    }).strict(),
  }),
  contract({
    type: "MedicationDoseNotGiven", version: 1, aggregateType: "MEDICATION_ADMINISTRATION", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "medication lifecycle (administerMedication, status REFUSED or HELD)",
    payload: z.object({
      administrationId: id, orderId: id, patientId: id, encounterId: optId, scheduledAt: iso,
      status: z.enum(["REFUSED", "HELD"]), reasonCode: z.enum(["REFUSED", "HELD", "PATIENT_ABSENT", "NPO", "OTHER"]),
      /** A late recording of a swept MISSED dose. */
      lateForAdministrationId: optId,
    }).strict(),
  }),
  contract({
    type: "MedicationSafetyWarningOverridden", version: 1, aggregateType: "MEDICATION_SAFETY_WARNING", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "medication lifecycle (acknowledgeSafetyWarning)",
    payload: z.object({
      warningId: id, orderId: id, patientId: id, encounterId: optId, severity: z.enum(["INFO", "WARNING", "DANGER"]),
      /** True when an override reason was given (required for DANGER); false is a plain acknowledgement. */
      overridden: z.boolean(), acknowledgedByStaffId: id,
    }).strict(),
  }),
  contract({
    type: "MedicationSubstituted", version: 1, aggregateType: "MEDICATION_SUBSTITUTION", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "pharmacy (recordSubstitution, dispense-time substitution)",
    payload: z.object({ substitutionId: id, orderId: id, patientId: id, encounterId: optId, replacementItemId: optId, authorizedByStaffId: id }).strict(),
  }),
  contract({
    type: "MedicationReconciliationRecorded", version: 1, aggregateType: "MEDICATION_RECONCILIATION", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "medication reconciliation (recordReconciliation)",
    payload: z.object({
      reconciliationId: id, encounterId: id, patientId: id, source: z.enum(["ADMISSION", "TRANSFER", "DISCHARGE"]),
      decision: z.enum(["CONTINUED", "MODIFIED", "STOPPED", "NEW"]), medicationOrderId: optId,
    }).strict(),
  }),
  contract({
    type: "MedicationRecallStatusChanged", version: 1, aggregateType: "MEDICATION_RECALL", scope: "FACILITY",
    sensitivity: "LOW", producer: "pharmacy (createRecall, closeRecall)",
    payload: z.object({
      recallId: id, itemId: id, itemLotId: optId, from: z.enum(["OPEN"]).nullable(), to: z.enum(["OPEN", "CLOSED"]),
      affectedLotCount: z.number().int().min(0),
    }).strict(),
  }),
  contract({
    type: "PharmacyComplianceRecorded", version: 1, aggregateType: "PHARMACY_COMPLIANCE", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "pharmacy (recordStorageCheck, recordControlledWastage)",
    payload: z.object({
      recordId: id, kind: z.enum(["STORAGE_CHECK", "CONTROLLED_WASTAGE"]), locationId: id,
      /** STORAGE_CHECK only: an EXCURSION is the safety fact. */
      storageStatus: z.enum(["OK", "EXCURSION"]).optional(),
      itemId: optId, itemLotId: optId, patientId: optId, witnessStaffId: optId,
    }).strict(),
  }),
  contract({
    type: "StockMoved", version: 1, aggregateType: "ITEM_LOT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "inventory ledger (postLedgerEntry): every stock movement, from every path, once per ledger entry",
    payload: z.object({
      ledgerEntryId: id, itemId: id, lotId: id, locationId: id,
      movementType: z.enum(["RECEIPT", "ISSUE", "TRANSFER_OUT", "TRANSFER_IN", "RETURN", "WASTE", "ADJUSTMENT", "RESERVATION", "RELEASE"]),
      onHandDelta: z.number(), reservedDelta: z.number(),
      unit: z.enum(["TABLET", "CAPSULE", "VIAL", "AMPOULE", "BOTTLE", "BOX", "PACK", "PIECE", "ML", "MG", "GRAM", "KG", "LITER", "OTHER"]),
      wasteReason: z.enum(["EXPIRED", "DAMAGED", "CONTAMINATED", "OPENED_UNUSED", "ACCIDENTAL_LOSS"]).optional(),
      adjustmentReason: z.enum(["COUNT_CORRECTION", "DAMAGE", "LOSS", "FOUND", "DATA_CORRECTION", "OTHER"]).optional(),
      /** The source document's model name and ID (never the reason text or notes). */
      sourceType: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,63}$/).optional(), sourceId: optId, movementGroupId: optId,
      /** A movement for a patient (an issue to an encounter): INTERNAL, not LOW. */
      patientId: optId, encounterId: optId,
    }).strict(),
  }),
  contract({
    type: "StockBelowReorder", version: 1, aggregateType: "ITEM", scope: "FACILITY",
    sensitivity: "LOW", producer: "inventory ledger (postLedgerEntry): an entry takes the item's balance at a location from at-or-above its reorder point to below it",
    payload: z.object({ itemId: id, locationId: id, ledgerEntryId: id, onHandQty: z.number(), reorderPoint: z.number(), reorderQuantity: z.number().optional() }).strict(),
  }),
  contract({
    type: "StockDocumentStatusChanged", version: 1, aggregateType: "STOCK_DOCUMENT", scope: "FACILITY",
    sensitivity: "LOW", producer: "inventory documents: adjustments (approve, reject), waste (approve, reject), stock takes (complete), goods receipts (reject; approval is GoodsReceived)",
    payload: z.object({
      /** Triage approved change 2: the closed code for the merged document kinds. */
      documentType: z.enum(["ADJUSTMENT", "WASTE", "GOODS_RECEIPT", "STOCK_TAKE"]),
      documentId: id,
      from: z.enum(["POSTED", "PENDING_APPROVAL", "APPROVED", "REJECTED", "RECORDED", "DRAFT", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
      to: z.enum(["POSTED", "PENDING_APPROVAL", "APPROVED", "REJECTED", "RECORDED", "DRAFT", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
      itemId: optId, locationId: optId,
      /** A stock take: how many lines had a variance (each posts StockMoved). */
      varianceLineCount: z.number().int().min(0).optional(),
    }).strict(),
  }),
  contract({
    type: "GoodsReceived", version: 1, aggregateType: "GOODS_RECEIPT", scope: "FACILITY",
    sensitivity: "LOW", producer: "procurement (approveGoodsReceipt: stock is posted on approval)",
    payload: z.object({ goodsReceiptId: id, purchaseOrderId: id, supplierId: id, lineCount: z.number().int().positive(), acceptedLineCount: z.number().int().min(0) }).strict(),
  }),
  contract({
    type: "PurchaseOrderStatusChanged", version: 1, aggregateType: "PURCHASE_ORDER", scope: "FACILITY",
    sensitivity: "LOW", producer: "procurement (approvePurchaseOrder: commits money to a supplier; cancelPurchaseOrder; closePurchaseOrder)",
    payload: z.object({
      purchaseOrderId: id, supplierId: id,
      from: z.enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED", "CLOSED"]),
      to: z.enum(["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENT", "PARTIALLY_RECEIVED", "RECEIVED", "CANCELLED", "CLOSED"]),
      totalMinor: minor, currency,
    }).strict(),
  }),
  contract({
    type: "SupplierInvoiceStatusChanged", version: 1, aggregateType: "SUPPLIER_INVOICE", scope: "FACILITY",
    sensitivity: "LOW", producer: "procurement (recordSupplierInvoice: received and three-way matched; reviewSupplierInvoice)",
    payload: z.object({
      invoiceId: id, supplierId: id, purchaseOrderId: optId,
      from: z.enum(["RECEIVED", "MATCHED", "DISCREPANCY", "APPROVED", "REJECTED"]).nullable(),
      to: z.enum(["RECEIVED", "MATCHED", "DISCREPANCY", "APPROVED", "REJECTED"]),
      totalMinor: minor,
      /** The three-way match's findings, as flags (never the match notes). */
      quantityMismatch: z.boolean(), priceMismatch: z.boolean(), missingReceipt: z.boolean(),
    }).strict(),
  }),
  contract({
    type: "SerialUnitStatusChanged", version: 1, aggregateType: "SERIAL_UNIT", scope: "FACILITY",
    sensitivity: "LOW", producer: "inventory serials (registerSerial, transitionSerial); never the serial number",
    payload: z.object({
      serialId: id, itemId: id, lotId: optId, locationId: optId,
      from: z.enum(["IN_STOCK", "RESERVED", "ISSUED", "RETURNED", "DISPOSED"]).nullable(),
      to: z.enum(["IN_STOCK", "RESERVED", "ISSUED", "RETURNED", "DISPOSED"]),
    }).strict(),
  }),
  contract({
    type: "SupplyRequestStatusChanged", version: 1, aggregateType: "SUPPLY_REQUEST", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "department supply requests (transitionDepartmentRequest), pharmacy requests (transitionPharmacyRequest); stock moves are their own StockMoved",
    payload: z.object({
      /** Which request model: the two share one status set. */
      requestKind: z.enum(["DEPARTMENT", "PHARMACY"]),
      requestId: id, itemId: id, quantity: z.number().positive(),
      from: z.enum(["REQUESTED", "APPROVED", "RESERVED", "ISSUED", "RECEIVED", "CANCELLED", "REJECTED"]),
      to: z.enum(["REQUESTED", "APPROVED", "RESERVED", "ISSUED", "RECEIVED", "CANCELLED", "REJECTED"]),
      /** A request for a patient (so INTERNAL). */
      patientId: optId, encounterId: optId,
    }).strict(),
  }),
  contract({
    type: "StockLotStatusChanged", version: 1, aggregateType: "ITEM_LOT", scope: "FACILITY",
    sensitivity: "LOW", producer: "inventory lots (quarantineLot, releaseLotFromQuarantine), pharmacy recalls",
    payload: z.object({ lotId: id, itemId: id, from: lotStatus, to: lotStatus, cause: z.enum(["QUARANTINE", "RELEASE", "RECALL"]), recallId: optId }).strict(),
  }),
  contract({
    type: "StockLotStatusChanged", version: 2, aggregateType: "ITEM_LOT", scope: "FACILITY",
    sensitivity: "LOW", producer: "inventory lots (quarantineLot, releaseLotFromQuarantine, expireLapsedLots), pharmacy recalls",
    /** v2 (batch 7): the expiry sweep (EXPIRY). */
    payload: z.object({ lotId: id, itemId: id, from: lotStatus, to: lotStatus, cause: z.enum(["QUARANTINE", "RELEASE", "RECALL", "EXPIRY"]), recallId: optId }).strict(),
  }),
  contract({
    type: "ObservationRecorded", version: 1, aggregateType: "OBSERVATION", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "ICU (recordObservation); ED reassessment and transfusion observations at steps 4/8",
    payload: z.object({
      observationId: id, encounterId: id, patientId: id,
      observationKind: z.enum(["ICU_VENTILATOR", "ICU_NEURO", "ICU_ABG", "ED_REASSESSMENT", "TRANSFUSION"]),
    }).strict(),
  }),
  contract({
    type: "ObservationRecorded", version: 2, aggregateType: "OBSERVATION", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "ICU, ED reassessment, transfusion observations; vitals (recordVitals) and intake/output (recordIntakeOutput) since batch 7",
    payload: z.object({
      observationId: id, encounterId: id, patientId: id,
      /** v2 (batch 7): VITALS, INTAKE and OUTPUT join the point-of-care kinds. */
      observationKind: z.enum(["ICU_VENTILATOR", "ICU_NEURO", "ICU_ABG", "ED_REASSESSMENT", "TRANSFUSION", "VITALS", "INTAKE", "OUTPUT"]),
      /** VITALS: some value is outside the facility's configured thresholds (never which, never the values). */
      abnormal: z.boolean().optional(),
    }).strict(),
  }),
  contract({
    type: "DiagnosisRecorded", version: 1, aggregateType: "DIAGNOSIS", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "diagnoses (recordDiagnosis: ADDED; updateDiagnosis: UPDATED | RESOLVED)",
    payload: z.object({
      diagnosisId: id, encounterId: id, patientId: id, action: z.enum(["ADDED", "UPDATED", "RESOLVED"]),
      diagnosisType: z.enum(["PRIMARY", "SECONDARY", "PROVISIONAL", "RULE_OUT", "FINAL"]),
      status: z.enum(["ACTIVE", "RESOLVED", "ENTERED_IN_ERROR"]),
      /** Whether it carries a terminology code (never the code or the text: a diagnosis code is the diagnosis). */
      coded: z.boolean(),
    }).strict(),
  }),
  contract({
    type: "AllergyListUpdated", version: 1, aggregateType: "ALLERGY", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "allergies (recordAllergy: ADDED; updateAllergy: UPDATED | INACTIVATED)",
    payload: z.object({
      allergyId: id, patientId: id, action: z.enum(["ADDED", "UPDATED", "INACTIVATED"]),
      status: z.enum(["ACTIVE", "INACTIVE", "ENTERED_IN_ERROR"]),
      severity: z.enum(["MILD", "MODERATE", "SEVERE"]),
      verification: z.enum(["UNCONFIRMED", "CONFIRMED"]),
      criticality: z.enum(["LOW", "HIGH", "UNABLE_TO_ASSESS"]).optional(),
    }).strict(),
  }),
  contract({
    // v2 (Week 4a): who it came from; a patient-reported allergy may have no severity (never guessed).
    type: "AllergyListUpdated", version: 2, aggregateType: "ALLERGY", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "allergies (recordAllergy, updateAllergy); the document pipeline's allergy bridge (source PATIENT_PROVIDED)",
    payload: z.object({
      allergyId: id, patientId: id, action: z.enum(["ADDED", "UPDATED", "INACTIVATED"]),
      status: z.enum(["ACTIVE", "INACTIVE", "ENTERED_IN_ERROR"]),
      severity: z.enum(["MILD", "MODERATE", "SEVERE"]).optional(),
      verification: z.enum(["UNCONFIRMED", "CONFIRMED"]),
      criticality: z.enum(["LOW", "HIGH", "UNABLE_TO_ASSESS"]).optional(),
      source: z.enum(["CLINICIAN", "PATIENT_PROVIDED"]),
    }).strict(),
  }),
  contract({
    // Week 4b (4a follow-up b): the record-level allergy status changed. Aggregate: the patient's status.
    type: "AllergyStatusRecorded", version: 1, aggregateType: "ALLERGY_STATUS", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "allergies (recordAllergyStatus: RECORDED; recordAllergy: ALLERGY_ADDED; updateAllergy: LAST_ALLERGY_INACTIVATED)",
    payload: z.object({
      entryId: id, patientId: id,
      status: allergyStatusAssertion, previousStatus: allergyStatusAssertion.nullable(),
      reason: z.enum(["RECORDED", "ALLERGY_ADDED", "LAST_ALLERGY_INACTIVATED"]),
    }).strict(),
  }),
  contract({
    // Week 4b: an embedding space of the AI index was created (BUILDING), switched to (ACTIVE) or retired (docs/RAG_DESIGN.md §5.8).
    type: "RagEmbeddingSpaceChanged", version: 1, aggregateType: "RAG_EMBEDDING_SPACE", scope: "PLATFORM",
    sensitivity: "LOW", producer: "AI index (startReembed: BUILDING; activateEmbeddingSpace: ACTIVE, and RETIRED for the space it replaces)",
    payload: z.object({
      spaceId: id, embeddingModel: z.string().min(1).max(100), embeddingVersion: z.number().int().min(1), provider: z.enum(["mock", "voyage", "india-hosted"]),
      dims: z.number().int().min(1).max(16000), status: z.enum(["BUILDING", "ACTIVE", "RETIRED"]), previous: z.enum(["BUILDING", "ACTIVE", "RETIRED"]).nullable(),
    }).strict(),
  }),
  contract({
    type: "ReferralStatusChanged", version: 1, aggregateType: "REFERRAL", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "referrals (createReferral: PLACED; respondToReferral)",
    payload: z.object({
      referralId: id, encounterId: id, patientId: id,
      from: z.enum(["DRAFT", "PLACED", "ACKNOWLEDGED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "REJECTED"]).nullable(),
      to: z.enum(["DRAFT", "PLACED", "ACKNOWLEDGED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "REJECTED"]),
      priority: orderPriority, toDepartmentId: optId, toStaffId: optId,
    }).strict(),
  }),
  contract({
    type: "IcuDeviceStatusChanged", version: 1, aggregateType: "ICU_DEVICE", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "ICU (recordDevice, updateDeviceStatus)",
    payload: z.object({ deviceId: id, encounterId: id, patientId: id, from: icuDeviceStatus.nullable(), to: icuDeviceStatus }).strict(),
  }),
  contract({
    type: "IcuInfusionStatusChanged", version: 1, aggregateType: "ICU_INFUSION", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "ICU (recordInfusion, updateInfusionStatus)",
    payload: z.object({
      infusionId: id, encounterId: id, patientId: id, medicationOrderId: optId,
      from: icuInfusionStatus.nullable(), to: icuInfusionStatus, rateChanged: z.boolean(),
    }).strict(),
  }),
  contract({
    type: "CarePlanUpdated", version: 1, aggregateType: "CARE_PLAN", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "care plans (createCarePlan, addIntervention, completeIntervention, closeCarePlan)",
    payload: z.object({
      carePlanId: id, patientId: id, encounterId: optId,
      change: z.enum(["CREATED", "INTERVENTION_ADDED", "INTERVENTION_COMPLETED", "CLOSED"]),
      status: z.enum(["ACTIVE", "COMPLETED", "CANCELLED"]), interventionId: optId, interventionCount: z.number().int().min(0),
    }).strict(),
  }),
  contract({
    type: "ProblemListUpdated", version: 1, aggregateType: "PROBLEM", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "problem list (addDiagnosisToProblemList)",
    payload: z.object({ problemId: id, patientId: id, diagnosisId: id, encounterId: id, created: z.boolean() }).strict(),
  }),
  contract({
    type: "ProblemListUpdated", version: 2, aggregateType: "PROBLEM", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "problem list (addDiagnosisToProblemList: DIAGNOSIS; addProblem, created by staff: MANUAL)",
    payload: z.object({
      problemId: id, patientId: id, created: z.boolean(),
      /** v2 (batch 6): a problem added by hand has no diagnosis or encounter. */
      source: z.enum(["DIAGNOSIS", "MANUAL"]), diagnosisId: optId, encounterId: optId,
    }).strict(),
  }),

  // ── Operating theatre and blood bank (spine §9 step 8) ───────────────────
  contract({
    type: "SurgeryRequested", version: 1, aggregateType: "SURGERY", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "surgery (requestSurgery)",
    payload: z.object({ surgeryId: id, encounterId: id, patientId: id, procedureId: optId, urgency: z.enum(["ELECTIVE", "URGENT", "EMERGENCY"]) }).strict(),
  }),
  contract({
    type: "SurgeryScheduled", version: 1, aggregateType: "SURGERY", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "surgery (scheduleSurgery)",
    payload: z.object({ surgeryId: id, scheduleId: id, operatingTheatreId: id, encounterId: id, patientId: id, startAt: iso, endAt: iso }).strict(),
  }),
  contract({
    type: "ProcedureStarted", version: 1, aggregateType: "SURGERY", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "surgery (startProcedure)",
    payload: z.object({ surgeryId: id, encounterId: id, patientId: id }).strict(),
  }),
  contract({
    type: "ProcedureCompleted", version: 1, aggregateType: "SURGERY", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "surgery (completeProcedure)",
    payload: z.object({ surgeryId: id, encounterId: id, patientId: id, procedureId: optId, durationMinutes: z.number().int().min(0) }).strict(),
  }),
  contract({
    type: "SurgeryItemUsed", version: 1, aggregateType: "SURGERY", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "surgery (recordItemUsage)",
    payload: z.object({
      usageId: id, surgeryId: id, encounterId: id, patientId: id, itemId: id, itemLotId: optId,
      usageType: z.enum(["IMPLANT", "CONSUMABLE"]), quantity: z.number().positive(),
      /** The stock location to issue from; absent: the usage is recorded without moving stock. */
      locationId: optId,
    }).strict(),
  }),
  contract({
    type: "SurgeryStatusChanged", version: 1, aggregateType: "SURGERY", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "surgery (transitionSurgery, cancelSchedule, updateRecovery)",
    payload: z.object({
      surgeryId: id, encounterId: id, patientId: id,
      /** STATUS: the case's lifecycle; SCHEDULE_CANCELLED: its theatre slot freed; RECOVERY: the PACU phase. */
      change: z.enum(["STATUS", "SCHEDULE_CANCELLED", "RECOVERY"]),
      from: z.union([surgeryStatus, recoveryStatus]).nullable(), to: z.union([surgeryStatus, recoveryStatus]),
    }).strict(),
  }),
  contract({
    type: "PerioperativeRecordRecorded", version: 1, aggregateType: "SURGERY", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "surgery (recordAnesthesia, updateChecklistItem)",
    payload: z.object({
      surgeryId: id, encounterId: id, patientId: id, recordId: id, kind: z.enum(["ANESTHESIA", "SAFETY_CHECKLIST"]),
      anesthesiaStatus: z.enum(["PLANNED", "IN_PROGRESS", "COMPLETED"]).optional(),
      checklistPhase: z.enum(["BEFORE_INDUCTION", "BEFORE_INCISION", "BEFORE_LEAVING"]).optional(), checked: z.boolean().optional(),
    }).strict(),
  }),
  contract({
    type: "BloodUnitStatusChanged", version: 1, aggregateType: "BLOOD_UNIT", scope: "FACILITY",
    sensitivity: "LOW", producer: "blood bank (every unit transition: register, release, quarantine, recall, waste, reserve, issue, return, transfuse)",
    payload: z.object({ unitId: id, productId: id, from: bloodUnitStatus.nullable(), to: bloodUnitStatus, recalled: z.boolean() }).strict(),
  }),
  contract({
    type: "BloodRequestStatusChanged", version: 1, aggregateType: "BLOOD_REQUEST", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "blood bank (requestBlood, transitionRequest, issue and transfusion completion)",
    payload: z.object({
      requestId: id, encounterId: id, patientId: id, from: bloodRequestStatus.nullable(), to: bloodRequestStatus,
      priority: z.enum(["ROUTINE", "URGENT", "EMERGENCY"]),
    }).strict(),
  }),
  contract({
    type: "EmergencyBloodReleaseAuthorized", version: 1, aggregateType: "BLOOD_REQUEST", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "blood bank (authorizeEmergencyRelease)",
    payload: z.object({ requestId: id, encounterId: id, patientId: id, authorizedByStaffId: id }).strict(),
  }),
  contract({
    type: "BloodCompatibilityRecorded", version: 1, aggregateType: "BLOOD_COMPATIBILITY", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "blood bank (recordPatientTyping, verifyCompatibility)",
    payload: z.object({
      recordId: id, patientId: id, encounterId: optId, kind: z.enum(["PATIENT_TYPING", "CROSSMATCH_VERIFIED"]),
      requestId: optId, unitId: optId,
      /** CROSSMATCH_VERIFIED only. */
      result: z.enum(["COMPATIBLE", "INCOMPATIBLE"]).optional(),
    }).strict(),
  }),
  contract({
    type: "BloodIssued", version: 1, aggregateType: "BLOOD_ISSUE", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "blood bank (issueUnit)",
    payload: z.object({ issueId: id, unitId: id, requestId: id, encounterId: id, patientId: id, productId: id, emergencyRelease: z.boolean() }).strict(),
  }),
  contract({
    type: "TransfusionStarted", version: 1, aggregateType: "TRANSFUSION", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "blood bank (startTransfusion)",
    payload: z.object({ transfusionId: id, unitId: id, requestId: id, encounterId: id, patientId: id }).strict(),
  }),
  contract({
    type: "TransfusionStatusChanged", version: 1, aggregateType: "TRANSFUSION", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "blood bank (transitionTransfusion)",
    payload: z.object({ transfusionId: id, unitId: id, encounterId: id, patientId: id, from: transfusionStatus, to: transfusionStatus }).strict(),
  }),
  contract({
    type: "TransfusionReactionReported", version: 1, aggregateType: "TRANSFUSION", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "blood bank (reportReaction)",
    payload: z.object({ reactionId: id, transfusionId: id, unitId: id, encounterId: id, patientId: id }).strict(),
  }),
  contract({
    type: "TransfusionReactionStatusChanged", version: 1, aggregateType: "TRANSFUSION", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "blood bank (transitionReaction)",
    payload: z.object({ reactionId: id, transfusionId: id, encounterId: id, patientId: id, from: transfusionReactionStatus, to: transfusionReactionStatus }).strict(),
  }),

  // ── Quality, safety and facility operations (spine §9 step 9b) ───────────
  contract({
    type: "QualityIncidentStatusChanged", version: 1, aggregateType: "QUALITY_INCIDENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "quality (createQualityIncident, transitionIncident, reopenIncident, reviewRca: the RCA review is a stage of the incident)",
    payload: z.object({
      incidentId: id, change: z.enum(["REPORTED", "TRANSITION", "REOPENED", "RCA_REVIEWED"]),
      from: z.enum(["REPORTED", "TRIAGED", "UNDER_INVESTIGATION", "ACTION_REQUIRED", "RESOLVED", "CLOSED", "CANCELLED"]).nullable(),
      to: z.enum(["REPORTED", "TRIAGED", "UNDER_INVESTIGATION", "ACTION_REQUIRED", "RESOLVED", "CLOSED", "CANCELLED"]),
      category: z.enum(["MEDICATION", "FALL", "PRESSURE_INJURY", "DIAGNOSTIC", "SURGICAL", "TRANSFUSION", "INFECTION", "EQUIPMENT", "OPERATIONAL", "SECURITY", "OTHER"]),
      severity: z.enum(["LOW", "MODERATE", "HIGH", "CRITICAL"]),
      confidentiality: z.enum(["STANDARD", "RESTRICTED"]),
      rcaId: optId,
      /** Only for a STANDARD incident: a RESTRICTED one never names the patient in the stream. */
      patientId: optId, encounterId: optId,
    }).strict(),
  }),
  contract({
    type: "CapaStatusChanged", version: 1, aggregateType: "CAPA", scope: "FACILITY",
    sensitivity: "LOW", producer: "quality (createCapa, transitionCapa)",
    payload: z.object({
      capaId: id, actionType: z.enum(["CORRECTIVE", "PREVENTIVE"]),
      from: z.enum(["OPEN", "IN_PROGRESS", "COMPLETED", "VERIFIED", "CLOSED", "CANCELLED"]).nullable(),
      to: z.enum(["OPEN", "IN_PROGRESS", "COMPLETED", "VERIFIED", "CLOSED", "CANCELLED"]),
      incidentId: optId, findingId: optId,
    }).strict(),
  }),
  contract({
    type: "QualityFindingStatusChanged", version: 1, aggregateType: "QUALITY_FINDING", scope: "FACILITY",
    sensitivity: "LOW", producer: "quality (createFinding, closeFinding)",
    payload: z.object({
      findingId: id, from: z.enum(["OPEN", "IN_PROGRESS", "CLOSED"]).nullable(), to: z.enum(["OPEN", "IN_PROGRESS", "CLOSED"]),
      severity: z.enum(["LOW", "MODERATE", "HIGH", "CRITICAL"]).optional(), auditId: optId, standardId: optId, measureId: optId, incidentId: optId,
    }).strict(),
  }),
  contract({
    type: "QualityMeasureStatusChanged", version: 1, aggregateType: "QUALITY_MEASURE", scope: "FACILITY",
    sensitivity: "LOW", producer: "quality (setMeasureStatus)",
    payload: z.object({
      measureId: id, standardId: id,
      from: z.enum(["PENDING", "COMPLIANT", "PARTIAL", "NON_COMPLIANT", "NOT_APPLICABLE"]),
      to: z.enum(["PENDING", "COMPLIANT", "PARTIAL", "NON_COMPLIANT", "NOT_APPLICABLE"]),
    }).strict(),
  }),
  contract({
    type: "DietOrderStatusChanged", version: 1, aggregateType: "DIET_ORDER", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "operations (createDietOrder, setDietOrderStatus)",
    payload: z.object({
      dietOrderId: id, encounterId: id, patientId: id,
      from: z.enum(["ACTIVE", "DISCONTINUED", "CANCELLED"]).nullable(), to: z.enum(["ACTIVE", "DISCONTINUED", "CANCELLED"]),
      /** The documented diet codes; a stored free-text type is reported as OTHER. Never the restrictions or notes. */
      dietType: z.enum(["REGULAR", "LIQUID", "SOFT", "CLEAR_LIQUID", "NPO", "THERAPEUTIC", "OTHER"]),
    }).strict(),
  }),
  contract({
    type: "EquipmentServiceRecorded", version: 1, aggregateType: "EQUIPMENT", scope: "FACILITY",
    sensitivity: "LOW", producer: "operations (recordEquipmentCalibration, recordEquipmentMaintenance, completePreventiveMaintenance)",
    payload: z.object({ recordId: id, equipmentId: optId, serviceKind: z.enum(["CALIBRATION", "MAINTENANCE", "PREVENTIVE"]), nextDueAt: iso.optional() }).strict(),
  }),
  contract({
    type: "EquipmentStatusChanged", version: 1, aggregateType: "EQUIPMENT", scope: "FACILITY",
    sensitivity: "LOW", producer: "operations (setEquipmentStatus; startDowntime, endDowntime: a downtime with or without a registered device)",
    payload: z.object({
      cause: z.enum(["MANUAL", "DOWNTIME_STARTED", "DOWNTIME_ENDED"]),
      equipmentId: optId, downtimeId: optId,
      /** Set when a registered device's status moved. */
      from: z.enum(["IN_SERVICE", "UNDER_MAINTENANCE", "OUT_OF_SERVICE", "RETIRED"]).optional(),
      to: z.enum(["IN_SERVICE", "UNDER_MAINTENANCE", "OUT_OF_SERVICE", "RETIRED"]).optional(),
    }).strict(),
  }),
  contract({
    type: "InfectionIncidentStatusChanged", version: 1, aggregateType: "INFECTION_INCIDENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "infection control (createInfectionIncident, transitionInfectionIncident, createInfectionInvestigation)",
    payload: z.object({
      incidentId: id, change: z.enum(["REPORTED", "TRANSITION", "INVESTIGATION_RECORDED"]),
      from: z.enum(["REPORTED", "UNDER_REVIEW", "INVESTIGATION", "ACTION_REQUIRED", "RESOLVED", "CLOSED", "CANCELLED"]).nullable(),
      to: z.enum(["REPORTED", "UNDER_REVIEW", "INVESTIGATION", "ACTION_REQUIRED", "RESOLVED", "CLOSED", "CANCELLED"]),
      /** The documented type codes; a stored free-text type is reported as OTHER. */
      incidentType: z.enum(["HAI", "CLABSI", "CAUTI", "SSI", "MDRO", "OTHER"]),
      isolationRequired: z.boolean(), investigationId: optId, patientId: optId, encounterId: optId,
    }).strict(),
  }),
  contract({
    type: "InfectionExposureRecorded", version: 1, aggregateType: "INFECTION_INCIDENT", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "infection control (recordExposure); never the exposed person's reference",
    payload: z.object({ exposureId: id, incidentId: id }).strict(),
  }),
  contract({
    type: "LabQualityControlRecorded", version: 1, aggregateType: "LAB_QC", scope: "FACILITY",
    sensitivity: "LOW", producer: "lab (recordQc, reviewQc, recordCalibration, reviewCalibration)",
    payload: z.object({
      recordKind: z.enum(["QC", "CALIBRATION"]), recordId: id, stage: z.enum(["RECORDED", "REVIEWED", "REJECTED"]),
      /** QC: the run's outcome (a failure is the quality fact); a label other than PASS/FAIL is OTHER. Never the values. */
      outcome: z.enum(["PASS", "FAIL", "OTHER", "UNRECORDED"]).optional(),
    }).strict(),
  }),
  contract({
    type: "MaintenanceRequestStatusChanged", version: 1, aggregateType: "MAINTENANCE_REQUEST", scope: "FACILITY",
    sensitivity: "LOW", producer: "operations (createMaintenanceRequest, transitionMaintenance): an equipment or facility fault",
    payload: z.object({
      requestId: id,
      from: z.enum(["REPORTED", "TRIAGED", "ASSIGNED", "IN_PROGRESS", "RESOLVED", "VERIFIED", "CLOSED", "CANCELLED"]).nullable(),
      to: z.enum(["REPORTED", "TRIAGED", "ASSIGNED", "IN_PROGRESS", "RESOLVED", "VERIFIED", "CLOSED", "CANCELLED"]),
      issueType: z.enum(["ELECTRICAL", "PLUMBING", "HVAC", "STRUCTURAL", "EQUIPMENT", "OTHER"]),
      priority: orderPriority, equipmentId: optId,
    }).strict(),
  }),

  // ── Access, identity, interoperability and workforce (spine §9 step 9c) ──
  contract({
    type: "BreakGlassStatusChanged", version: 1, aggregateType: "BREAK_GLASS", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "break-glass (activateBreakGlass, completeBreakGlass, revokeBreakGlass, expireLapsedBreakGlass); never the reason",
    payload: z.object({
      breakGlassId: id, patientId: id, actorUserId: id, encounterId: optId,
      from: z.enum(["ACTIVE", "EXPIRED", "REVOKED", "COMPLETED"]).nullable(), to: z.enum(["ACTIVE", "EXPIRED", "REVOKED", "COMPLETED"]),
      emergencyContext: z.enum(["LIFE_THREATENING", "UNCONSCIOUS_PATIENT", "MASS_CASUALTY", "URGENT_TRANSFER", "CLINICAL_HANDOVER", "OTHER_URGENT"]),
    }).strict(),
  }),
  contract({
    type: "PrivacyRequestStatusChanged", version: 1, aggregateType: "PRIVACY_REQUEST", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "privacy (createPrivacyRequest, transitionPrivacyRequest): a DPDP data-subject request; never the reason or decision note",
    payload: z.object({
      privacyRequestId: id, patientId: id,
      requestType: z.enum(["ACCESS", "CORRECTION", "RESTRICTION", "WITHDRAW_CONSENT", "DELETION_REQUEST"]),
      requesterType: z.enum(["PATIENT", "STAFF_ON_BEHALF", "GUARDIAN"]),
      from: z.enum(["REQUESTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "ACTIONED", "CANCELLED"]).nullable(),
      to: z.enum(["REQUESTED", "UNDER_REVIEW", "APPROVED", "REJECTED", "ACTIONED", "CANCELLED"]),
    }).strict(),
  }),
  contract({
    type: "LegalHoldSet", version: 1, aggregateType: "PRIVACY_REQUEST", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "privacy (setLegalHold): changes how the record may be erased; never the reason",
    payload: z.object({ privacyRequestId: id, patientId: id, hold: z.boolean() }).strict(),
  }),
  contract({
    type: "HealthInformationExchangeRequested", version: 1, aggregateType: "HEALTH_EXCHANGE", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "interoperability (createExchange): a disclosure of the record to another party",
    payload: z.object({
      exchangeId: id, patientId: optId, direction: z.enum(["OUTBOUND", "INBOUND"]),
      purpose: z.enum(["TREATMENT", "REFERRAL", "SECOND_OPINION", "INSURANCE", "PATIENT_ACCESS", "RESEARCH", "OTHER"]),
      scopes: z.array(z.enum(["ALL_CLINICAL", "DIAGNOSIS", "LAB", "IMAGING", "MEDICATION", "DOCUMENTS", "ENCOUNTER", "ALLERGY", "VITALS", "CARE_PLAN", "BILLING"])),
      consentId: optId,
    }).strict(),
  }),
  contract({
    type: "HealthInformationExchangeStatusChanged", version: 1, aggregateType: "HEALTH_EXCHANGE", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "interoperability (authorize, reject, cancel, dispatch: processing, completed, failed); never the error text or the bundle",
    payload: z.object({
      exchangeId: id, patientId: optId, direction: z.enum(["OUTBOUND", "INBOUND"]),
      from: z.enum(["REQUESTED", "AUTHORIZED", "PROCESSING", "COMPLETED", "REJECTED", "FAILED", "CANCELLED"]),
      to: z.enum(["REQUESTED", "AUTHORIZED", "PROCESSING", "COMPLETED", "REJECTED", "FAILED", "CANCELLED"]),
      resourceCount: z.number().int().min(0).optional(),
    }).strict(),
  }),
  contract({
    type: "ExternalIdentifierStatusChanged", version: 1, aggregateType: "EXTERNAL_IDENTIFIER", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "interoperability (linkExternalIdentifier, unlinkExternalIdentifier, verifyExternalIdentifier); never the identifier value",
    payload: z.object({
      identifierId: id, entityType: z.enum(["PATIENT", "FACILITY", "STAFF", "ENCOUNTER", "ORGANIZATION", "DOCUMENT", "PAYER"]), entityId: id,
      /** The registry, as a code (IDENTIFIER_SYSTEMS key); a partner system is OTHER. */
      system: z.enum(["ABHA_NUMBER", "ABHA_ADDRESS", "HFR", "HPR", "LOCAL_UHID", "LOCAL_MRN", "OTHER"]),
      change: z.enum(["LINKED", "UNLINKED", "VERIFIED", "VERIFICATION_FAILED"]),
      status: z.enum(["ACTIVE", "SUPERSEDED", "REVOKED", "INVALID"]),
      verificationStatus: z.enum(["UNVERIFIED", "VERIFIED", "FAILED"]),
    }).strict(),
  }),
  contract({
    type: "ImportedResourceReviewed", version: 1, aggregateType: "IMPORTED_RESOURCE", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "FHIR import (reviewImportedResource): accepted imports enter the record; never the resource or the note",
    payload: z.object({ importedResourceId: id, from: z.enum(["RECEIVED", "MAPPED", "IMPORTED", "REJECTED", "CONFLICT"]), decision: z.enum(["MAPPED", "REJECTED"]) }).strict(),
  }),
  contract({
    type: "StaffAuthorizationChanged", version: 1, aggregateType: "STAFF_AUTHORIZATION", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "workforce (assignments, credentials, privileges): what staff may act on, prescribe or sign off",
    payload: z.object({
      /** Triage approved change 2: the closed code for the merged kinds, and whose authorization changed. */
      changeType: z.enum(["DEPARTMENT", "CREDENTIAL", "PRIVILEGE"]), subjectStaffId: id, recordId: id,
      from: z.enum(["ACTIVE", "ENDED", "PENDING", "VERIFIED", "EXPIRED", "SUSPENDED", "REVOKED"]).nullable(),
      to: z.enum(["ACTIVE", "ENDED", "PENDING", "VERIFIED", "EXPIRED", "SUSPENDED", "REVOKED"]),
      departmentId: optId,
      credentialType: z.enum(["REGISTRATION", "QUALIFICATION", "CERTIFICATION", "LICENSE", "SPECIALTY", "TRAINING"]).optional(),
    }).strict(),
  }),

  // ── Hospital billing: pricing of charges posted without a tariff (batch 5) ──
  contract({
    type: "ChargeRepriced", version: 1, aggregateType: "CHARGE", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (priceCharge: a needs-pricing charge priced)",
    payload: z.object({
      chargeId: id, encounterId: id, patientId: id, unitPriceMinor: minor, netAmountMinor: minor, currency,
      /** True when priced from a tariff code, false for an explicit amount. */
      fromTariff: z.boolean(),
    }).strict(),
  }),
  contract({
    type: "ChargeWaived", version: 1, aggregateType: "CHARGE", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (waiveCharge: a needs-pricing charge waived)",
    payload: z.object({
      chargeId: id, encounterId: id, patientId: id,
      reasonCode: z.enum(["PACKAGE_INCLUDED", "GOODWILL", "CHARITY", "CLINICAL_ERROR", "NOT_BILLABLE", "OTHER"]),
    }).strict(),
  }),

  // ── Hospital billing, claims and NHCX (spine §9 step 9) ───────────────────
  contract({
    type: "ChargePosted", version: 1, aggregateType: "CHARGE", scope: "FACILITY",
    sensitivity: "LOW", producer: "charge capture (createCharge, createChargeIfNotExists when it inserts): every charge path",
    payload: z.object({
      chargeId: id, encounterId: id, patientId: id,
      /** CHARGE_CATEGORIES (chargeCapture.ts). */
      category: z.enum(["CONSULTATION", "BED", "PROCEDURE", "LAB", "IMAGING", "PHARMACY", "NURSING", "PACKAGE", "OTHER"]),
      /** The source's model name (LabOrder, Surgery, …) and ID; never its content. */
      sourceType: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,63}$/).optional(), sourceId: optId,
      netAmountMinor: minor, currency,
      pricingStatus: z.enum(["PRICED", "NEEDS_PRICING"]),
      /** Posted after the encounter's invoice was issued: collected on a supplementary invoice. */
      isLate: z.boolean(),
    }).strict(),
  }),
  contract({
    type: "ChargeVoided", version: 1, aggregateType: "CHARGE", scope: "FACILITY",
    sensitivity: "LOW", producer: "charge capture (voidCharge: an un-invoiced charge)",
    payload: z.object({ chargeId: id, encounterId: id, patientId: id, netAmountMinor: minor, currency }).strict(),
  }),
  contract({
    type: "HospitalInvoiceIssued", version: 1, aggregateType: "HOSPITAL_INVOICE", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (issueInvoice: invoices, supplementary invoices and debit notes)",
    payload: z.object({
      invoiceId: id, encounterId: id, patientId: id, totalMinor: minor, currency, lineCount: z.number().int().positive(),
      documentType: invoiceDocumentType,
      /** Set on a supplementary invoice or debit note: the issued invoice it supplements. */
      supplementsInvoiceId: optId,
    }).strict(),
  }),
  contract({
    type: "HospitalInvoiceVoided", version: 1, aggregateType: "HOSPITAL_INVOICE", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (voidInvoice)",
    payload: z.object({ invoiceId: id, encounterId: id, patientId: id, from: invoiceStatus, totalMinor: minor, currency, documentType: invoiceDocumentType }).strict(),
  }),
  contract({
    type: "HospitalPaymentRecorded", version: 1, aggregateType: "HOSPITAL_PAYMENT", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (recordPayment: the idempotent insert, first time only)",
    payload: z.object({ paymentId: id, billingAccountId: id, encounterId: id, patientId: id, amountMinor: minor, currency, method: paymentMethod }).strict(),
  }),
  contract({
    type: "HospitalPaymentStatusChanged", version: 1, aggregateType: "HOSPITAL_PAYMENT", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (allocatePayment, voidPayment)",
    payload: z.object({
      paymentId: id, encounterId: id, patientId: id, change: z.enum(["ALLOCATED", "VOIDED"]), status: paymentStatus,
      /** ALLOCATED: the invoice, the amount allocated and the invoice's status after it. */
      invoiceId: optId, amountMinor: minor, currency, invoiceStatus: invoiceStatus.optional(),
    }).strict(),
  }),
  contract({
    type: "HospitalRefundStatusChanged", version: 1, aggregateType: "HOSPITAL_REFUND", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (completeRefund, rejectRefund)",
    payload: z.object({ refundId: id, paymentId: id, encounterId: id, patientId: id, from: refundStatus, to: refundStatus, amountMinor: minor, currency }).strict(),
  }),
  contract({
    type: "BillingAdjustmentStatusChanged", version: 1, aggregateType: "BILLING_ADJUSTMENT", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (approveAdjustment, rejectAdjustment)",
    payload: z.object({ adjustmentId: id, invoiceId: id, encounterId: id, patientId: id, adjustmentType, from: adjustmentStatus, to: adjustmentStatus, amountMinor: minor, currency }).strict(),
  }),
  contract({
    type: "CoverageStatusChanged", version: 1, aggregateType: "COVERAGE", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (addPatientCoverage, deactivateCoverage)",
    payload: z.object({ coverageId: id, patientId: id, payerId: id, from: coverageStatus.nullable(), to: coverageStatus, priorityOrder: z.number().int() }).strict(),
  }),
  contract({
    type: "PreauthStatusChanged", version: 1, aggregateType: "PREAUTH", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (requestPreAuth, expirePreAuth); the decision is PreauthDecided",
    payload: z.object({ preAuthId: id, coverageId: id, encounterId: id, patientId: id, from: preAuthStatus.nullable(), to: preAuthStatus, requestedAmountMinor: minor }).strict(),
  }),
  contract({
    type: "PreauthDecided", version: 1, aggregateType: "PREAUTH", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (decidePreAuth)",
    payload: z.object({
      preAuthId: id, coverageId: id, encounterId: id, patientId: id, decision: z.enum(["APPROVED", "DENIED"]),
      /** Minor units of the facility's currency (a pre-authorization stores none of its own). */
      approvedAmountMinor: minor.optional(),
    }).strict(),
  }),
  contract({
    type: "ClaimDrafted", version: 1, aggregateType: "CLAIM", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (createClaimDraft: by staff, or by claim-drafting on HospitalInvoiceIssued)",
    payload: z.object({
      claimId: id, invoiceId: id, coverageId: id, encounterId: id, patientId: id, preAuthId: optId,
      submittedAmountMinor: minor, currency,
    }).strict(),
  }),
  contract({
    type: "ClaimSubmitted", version: 1, aggregateType: "CLAIM", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (submitClaim: direct) and NHCX (dispatchSubmission: the exchange create)",
    payload: z.object({
      claimId: id, encounterId: id, patientId: id, channel: z.enum(["DIRECT", "NHCX"]),
      /** NHCX only. */
      submissionId: optId, exchangeId: optId, version: z.number().int().positive().optional(),
    }).strict(),
  }),
  contract({
    type: "ClaimStatusChanged", version: 1, aggregateType: "CLAIM", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (recordClaimDecision, closeClaim); submission is ClaimSubmitted, settlement ClaimSettled",
    payload: z.object({
      claimId: id, invoiceId: id, encounterId: id, patientId: id, from: claimStatus, to: claimStatus,
      approvedAmountMinor: minor.optional(), currency,
    }).strict(),
  }),
  contract({
    type: "ClaimSettled", version: 1, aggregateType: "CLAIM", scope: "FACILITY",
    sensitivity: "LOW", producer: "billing (settleClaim: SETTLED); NHCX (recordSettlement: NOTIFIED, reconcileSettlement: RECONCILED)",
    payload: z.object({
      claimId: id, invoiceId: id, encounterId: id, patientId: id,
      /** SETTLED: the approved amount finalized; NOTIFIED: the payer's settlement notice; RECONCILED: matched to a payment. */
      stage: z.enum(["SETTLED", "NOTIFIED", "RECONCILED"]),
      settlementId: optId, settledAmountMinor: minor, currency,
    }).strict(),
  }),
  contract({
    type: "ClaimQueryStatusChanged", version: 1, aggregateType: "CLAIM_QUERY", scope: "FACILITY",
    sensitivity: "LOW", producer: "NHCX queries (recordQuery, transitionQuery, respondToQuery); never the question or answer",
    payload: z.object({ queryId: id, claimId: id, submissionId: id, patientId: id, from: claimQueryStatus.nullable(), to: claimQueryStatus }).strict(),
  }),
  contract({
    type: "ClaimReconciliationStatusChanged", version: 1, aggregateType: "CLAIM_RECONCILIATION_EXCEPTION", scope: "FACILITY",
    sensitivity: "LOW", producer: "NHCX reconciliation (raiseException, resolveException); never the detail or note",
    payload: z.object({
      exceptionId: id, claimId: optId, invoiceId: optId, settlementId: optId,
      exceptionType: claimExceptionType, severity: alertSeverity,
      from: claimExceptionStatus.nullable(), to: claimExceptionStatus, varianceMinor: minor.optional(),
    }).strict(),
  }),

  // ── Documents, notes, patient access and consent (spine §9 step 7) ────────
  contract({
    type: "PatientDocumentUploaded", version: 1, aggregateType: "CLINICAL_DOCUMENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "patient portal (uploadPatientDocument)",
    payload: z.object({ documentId: id, patientId: id, documentType: z.enum(["REPORT", "REFERRAL_LETTER", "ID_PROOF", "OTHER"]), uploadedBy: z.enum(["PATIENT"]) }).strict(),
  }),
  contract({
    type: "ClinicalDocumentRecorded", version: 1, aggregateType: "CLINICAL_DOCUMENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "staff documents (recordStaffDocument, versionStaffDocument): created final, so the create is the fact",
    payload: z.object({
      documentId: id, patientId: id, encounterId: optId,
      /** CLINICAL_DOCUMENT_TYPE_CODES (staffDocuments.ts); a legacy free-text type is reported as OTHER. Never the title. */
      documentType: z.enum(["REPORT", "CONSENT_FORM", "REFERRAL_LETTER", "DISCHARGE_SUMMARY", "ID_PROOF", "OTHER", "PRESCRIPTION", "OPD_SUMMARY", "LAB_REPORT",
        "RADIOLOGY_REPORT", "INVOICE", "REFUND_NOTE", "CLAIM_PACKET", "CERTIFICATE", "DEATH_CERTIFICATE", "BIRTH_RECORD"]),
      accessPolicy: z.enum(["CLINICAL_STAFF", "PATIENT_VISIBLE", "RESTRICTED"]),
      version: z.number().int().positive(),
      /** A new version: the one it supersedes. */
      supersedesDocumentId: optId,
    }).strict(),
  }),
  contract({
    type: "DocumentGenerated", version: 1, aggregateType: "CLINICAL_DOCUMENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "documents (generateAndStoreDocument)",
    payload: z.object({
      documentId: id, generatedDocumentId: id, patientId: id, encounterId: optId, isDraft: z.boolean(),
      documentType: z.enum(["prescription", "opd-summary", "discharge-summary", "lab-report", "radiology-report", "invoice", "refund-note", "claim-packet", "certificate", "referral-letter", "death-certificate", "birth-record"]),
    }).strict(),
  }),
  contract({
    type: "ClinicalNoteSigned", version: 1, aggregateType: "CLINICAL_NOTE", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "clinical notes (signNote, amendNote, createNote when created signed)",
    payload: z.object({
      /** The signed note (also the aggregate id). Keys avoid "note": the sensitive-key guard refuses them. */
      entryId: id, encounterId: id, patientId: id,
      /** The note type code (SOAP, PROGRESS, DISCHARGE_SUMMARY, …), never its content. */
      entryType: z.string().regex(/^[A-Z][A-Z_]{1,39}$/),
      /** Set on an amendment: the signed note this one replaces. */
      supersedesEntryId: optId,
    }).strict(),
  }),
  contract({
    type: "FamilyAccessGranted", version: 1, aggregateType: "PATIENT_DELEGATION", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "patient portal (acceptDelegation: access starts on acceptance)",
    payload: z.object({ delegationId: id, patientId: id, delegateUserId: id, scopes: z.array(delegationScope).min(1) }).strict(),
  }),
  contract({
    type: "FamilyAccessRevoked", version: 1, aggregateType: "PATIENT_DELEGATION", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "patient portal (revokeDelegation), delegation expiry in the runner",
    payload: z.object({ delegationId: id, patientId: id, delegateUserId: id, reason: z.enum(["REVOKED", "EXPIRED"]) }).strict(),
  }),
  contract({
    type: "ConsentExpired", version: 1, aggregateType: "CONSENT", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "consent (expireLapsedConsents)",
    payload: z.object({ consentId: id, patientId: id }).strict(),
  }),
  contract({
    type: "ConsentRequestStatusChanged", version: 1, aggregateType: "CONSENT", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "consent (requestConsent, closeConsentRequest)",
    payload: z.object({ consentId: id, patientId: id, from: z.enum(["REQUESTED"]).nullable(), to: z.enum(["REQUESTED", "DECLINED", "CANCELLED"]) }).strict(),
  }),
  contract({
    type: "PatientAccessSessionStatusChanged", version: 1, aggregateType: "PATIENT_ACCESS_SESSION", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "patient access codes (redeem, extend, end, expiry): tenant = the facility where the access occurs (the redeeming clinician's); an unredeemed code emits nothing",
    payload: z.object({
      /** The access session (also the aggregate id). Keys avoid "session": the sensitive-key guard refuses them. */
      accessGrantId: id, patientId: id,
      from: accessSessionStatus.nullable(), to: accessSessionStatus,
      endedBy: z.enum(["DOCTOR", "PATIENT", "SYSTEM"]).optional(),
      /** ACTIVE → ACTIVE: the doctor extended the session. */
      extended: z.boolean(), doctorStaffId: optId,
    }).strict(),
  }),
  contract({
    type: "PatientAccountLinked", version: 1, aggregateType: "PATIENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "self-registration (verifyLinkOtp, decideLinkRequest LINK) until Phase 0",
    // Phase 0: accounts no longer link to facility records; Persons do, through
    // a verified link, and the front desk can no longer link (part 1c).
    retired: { since: "Phase 0 (2026-10-19)", replacedBy: "PersonPatientLinked" },
    payload: z.object({ patientId: id, linkRequestId: id, portalUserId: id, via: z.enum(["OTP", "FRONT_DESK"]) }).strict(),
  }),
  contract({
    type: "PatientDemographicsUpdated", version: 1, aggregateType: "PATIENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "patient profile (updateProfile), identifiers (addPatientIdentifier, Aarogya types)",
    payload: z.object({
      patientId: id, changeKind: z.enum(["PROFILE", "IDENTIFIER_ADDED"]),
      /** PROFILE: which fields changed, never their values. */
      fields: z.array(z.enum(["PREFERRED_NAME", "PHONE", "ADDRESS", "LANGUAGE", "COMMUNICATION_PREFERENCE"])).optional(),
      identifierType: z.enum(["UHID", "MRN"]).optional(),
    }).strict(),
  }),
  contract({
    type: "PatientDemographicsUpdated", version: 2, aggregateType: "PATIENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "patient profile (updateProfile), staff edits (updatePatientRecord, addEmergencyContact), identifiers (addPatientIdentifier)",
    payload: z.object({
      patientId: id,
      /** v2 (batch 7): staff edits and emergency contacts. */
      changeKind: z.enum(["PROFILE", "IDENTIFIER_ADDED", "EMERGENCY_CONTACT_ADDED"]),
      /** PROFILE: which fields changed, never their values. */
      fields: z.array(z.enum(["FULL_NAME", "PREFERRED_NAME", "PHONE", "ADDRESS", "BLOOD_GROUP", "LANGUAGE", "DECEASED", "COMMUNICATION_PREFERENCE"])).optional(),
      identifierType: z.enum(["UHID", "MRN"]).optional(),
    }).strict(),
  }),

  // ── Interoperability ─────────────────────────────────────────────────────────
  contract({
    type: "ConsentGranted", version: 1, aggregateType: "CONSENT", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "interoperability consent",
    payload: z.object({ consentId: id, patientId: id }).strict(),
  }),
  contract({
    type: "ConsentRevoked", version: 1, aggregateType: "CONSENT", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "interoperability consent",
    payload: z.object({ consentId: id, patientId: id }).strict(),
  }),

  // ── Commercial (D2–D5 canonical services) ────────────────────────────────────
  contract({
    type: "SubscriptionActivated", version: 1, aggregateType: "SUBSCRIPTION", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "commercial subscriptions (assignPlan)",
    payload: z.object({ subscriptionId: id, planId: id, billingInterval: id }).strict(),
  }),
  contract({
    type: "SubscriptionRenewed", version: 1, aggregateType: "SUBSCRIPTION", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "commercial subscriptions (applyPaidRenewal)",
    payload: z.object({ subscriptionId: id, periodStart: iso, periodEnd: iso }).strict(),
  }),
  contract({
    type: "SubscriptionCancelled", version: 1, aggregateType: "SUBSCRIPTION", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "commercial subscriptions (cancelSubscription)",
    payload: z.object({ subscriptionId: id, immediate: z.boolean() }).strict(),
  }),
  contract({
    type: "InvoiceCreated", version: 1, aggregateType: "INVOICE", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "billing invoices (generateInvoiceForPeriod)",
    payload: z.object({ invoiceId: id, totalMinor: minor, currency }).strict(),
  }),
  contract({
    type: "InvoiceFinalized", version: 1, aggregateType: "INVOICE", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "billing invoices (finalizeInvoiceTx)",
    payload: z.object({ invoiceId: id, invoiceNumber: id, totalMinor: minor, currency }).strict(),
  }),
  contract({
    type: "PaymentReceived", version: 1, aggregateType: "PAYMENT", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "billing payments (recordPayment)",
    payload: z.object({ paymentId: id, invoiceId: id, amountMinor: minor, currency }).strict(),
  }),
  contract({
    type: "PaymentFailed", version: 1, aggregateType: "PAYMENT", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "billing payments/webhooks",
    payload: z.object({ attemptId: id, invoiceId: optId, amountMinor: minor, currency, failureCode: optId }).strict(),
  }),
  contract({
    type: "RefundIssued", version: 1, aggregateType: "REFUND", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "billing refunds (refundPayment)",
    payload: z.object({ refundId: id, paymentId: id, amountMinor: minor, currency }).strict(),
  }),
  contract({
    type: "ReconciliationExceptionCreated", version: 1, aggregateType: "RECONCILIATION_EXCEPTION", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "commercial reconciliation / leakage detection",
    payload: z.object({ exceptionId: id, kind: id, severity: id, source: id }).strict(),
  }),
  contract({
    type: "ReconciliationExceptionResolved", version: 1, aggregateType: "RECONCILIATION_EXCEPTION", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "commercial reconciliation intelligence (transitionException)",
    payload: z.object({ exceptionId: id, status: id }).strict(),
  }),
  contract({
    type: "InvoiceVoided", version: 1, aggregateType: "INVOICE", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "commercial billing (voidInvoice)",
    payload: z.object({ invoiceId: id, from: billingInvoiceStatus, totalMinor: minor, currency }).strict(),
  }),
  contract({
    type: "CreditStatusChanged", version: 1, aggregateType: "CREDIT", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "commercial billing (issueCredit, applyCreditToInvoice)",
    payload: z.object({
      creditId: id, change: z.enum(["ISSUED", "APPLIED"]), status: billingCreditStatus, creditType: billingCreditType,
      /** ISSUED: the credit's amount; APPLIED: the amount applied, with the invoice. */
      amountMinor: minor, remainingMinor: minor, currency, invoiceId: optId,
    }).strict(),
  }),
  contract({
    type: "SubscriptionStatusChanged", version: 1, aggregateType: "SUBSCRIPTION", scope: "ORGANIZATION",
    sensitivity: "LOW", producer: "commercial subscriptions (transitionSubscription); entitlements follow it",
    payload: z.object({ subscriptionId: id, from: subscriptionStatus, to: subscriptionStatus }).strict(),
  }),

  // ── Person identity (Phase 0) ─────────────────────────────────────────────
  // A Person belongs to no facility (PERSON scope); link events belong to the
  // facility whose record was linked and carry the personId.
  contract({
    type: "PersonCreated", version: 1, aggregateType: "PERSON", scope: "PERSON",
    sensitivity: "INTERNAL", producer: "person identity (createPersonForAccount: sign-up, the identity migration)",
    payload: z.object({ personId: id, source: z.enum(PERSON_SOURCES) }).strict(),
  }),
  contract({
    type: "PersonPatientLinked", version: 1, aggregateType: "PERSON_PATIENT_LINK", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "person identity (recordActiveLink: self-created at sign-up, phone code, in-person ID, ABHA)",
    payload: z.object({ linkId: id, personId: id, patientId: id, method: personLinkMethod }).strict(),
  }),
  contract({
    type: "PersonPatientUnlinked", version: 1, aggregateType: "PERSON_PATIENT_LINK", scope: "FACILITY",
    sensitivity: "SENSITIVE", producer: "person identity (unlinkByPerson; approveFacilityUnlink with two staff members)",
    payload: z.object({ linkId: id, personId: id, patientId: id, by: z.enum(["PERSON", "FACILITY", "PLATFORM"]), reason: z.enum(["PERSON_REQUEST", "WRONG_PERSON", "FACILITY_MERGE", "PERSON_MERGE", "SECURITY", "ACCOUNT_CLOSED"]) }).strict(),
  }),
  contract({
    type: "PersonLinkReverificationRequired", version: 1, aggregateType: "PERSON_PATIENT_LINK", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "person identity (the identity migration: an existing account link without verification evidence)",
    payload: z.object({ linkId: id, personId: id, patientId: id, reason: z.enum(["FRONT_DESK_LINK", "NO_EVIDENCE"]) }).strict(),
  }),
  contract({
    type: "PersonPatientLinkSuperseded", version: 1, aggregateType: "PERSON_PATIENT_LINK", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "person identity (a facility merge carries or supersedes a record's link; an unmerge restores it)",
    payload: z.object({ linkId: id, personId: id, patientId: id, replacedByLinkId: optId, cause: z.enum(["FACILITY_MERGE", "FACILITY_UNMERGE"]), mergeRecordId: id }).strict(),
  }),
  contract({
    type: "PersonMerged", version: 1, aggregateType: "PERSON", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "person identity (confirmPersonMerge: one human proved control of both accounts)",
    payload: z.object({ personId: id, sourcePersonId: id, mergeRecordId: id, method: z.enum(["BOTH_ACCOUNTS_PROVEN"]) }).strict(),
  }),
  contract({
    type: "PersonDocumentUploaded", version: 1, aggregateType: "PERSON_DOCUMENT", scope: "PERSON",
    sensitivity: "INTERNAL", producer: "person identity (uploadPersonDocument: the person's own upload, tied to no facility)",
    payload: z.object({ personId: id, documentId: id, documentType: z.enum(["REPORT", "REFERRAL_LETTER", "ID_PROOF", "OTHER"]) }).strict(),
  }),
  contract({
    type: "PersonDocumentWithdrawn", version: 1, aggregateType: "PERSON_DOCUMENT", scope: "PERSON",
    sensitivity: "INTERNAL", producer: "person identity (withdrawPersonDocument)",
    payload: z.object({ personId: id, documentId: id }).strict(),
  }),
  contract({
    type: "PersonAccountClosed", version: 1, aggregateType: "PERSON", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "person identity (closePersonAccount: the person's own login, confirmed)",
    payload: z.object({ personId: id, purgeAfter: iso }).strict(),
  }),
  contract({
    type: "PersonAccountReopened", version: 1, aggregateType: "PERSON", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "person identity (reopenPersonAccount, within the 30-day grace period)",
    payload: z.object({ personId: id }).strict(),
  }),
  contract({
    type: "PersonDataPurged", version: 1, aggregateType: "PERSON", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "person identity (purgeClosedPersons: the runner, after the grace period; deferred under a legal hold)",
    payload: z.object({ personId: id, documentsDeleted: z.number().int().min(0), documentsKept: z.number().int().min(0), linksEnded: z.number().int().min(0) }).strict(),
  }),
  contract({
    type: "PatientContactConfirmed", version: 1, aggregateType: "PATIENT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "person identity (confirmPatientContact: staff confirm the record's phone with the patient present)",
    payload: z.object({ patientId: id, contact: z.enum(["PHONE"]), via: z.enum(["STAFF_IN_PERSON"]) }).strict(),
  }),
  contract({
    type: "PersonConsentDecided", version: 1, aggregateType: "PERSON", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "person identity (decidePersonConsent: the person's own choice, e.g. sharing uploads with treating hospitals)",
    payload: z.object({ personId: id, consentId: id, purpose: z.enum(["SHARE_UPLOADS_WITH_TREATING"]), decision: z.enum(["GRANTED", "DECLINED"]), previous: z.enum(["NONE", "GRANTED", "DECLINED"]) }).strict(),
  }),
  // Week 4c — consent sharing (docs/CONSENT_SHARING_DESIGN.md §9).
  contract({
    type: "RecordShareCreated", version: 1, aggregateType: "RECORD_SHARE", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "consent sharing (a code issued with a share; an access request approved)",
    payload: z.object({
      shareId: id, personId: id, kind: shareKind, status: shareStatus, purpose: sharePurpose, categories: z.array(shareCategory).min(1),
      sensitiveCategories: z.array(sensitiveCategory), hasPeriod: z.boolean(), expiresAt: iso,
    }).strict(),
  }),
  contract({
    type: "RecordShareStatusChanged", version: 1, aggregateType: "RECORD_SHARE", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "consent sharing (redeemed, the visit ended, expired, ended by the person, revoke-all, account closed)",
    payload: z.object({ shareId: id, personId: id, from: shareStatus, to: shareStatus, endedReason: shareEndReason.optional() }).strict(),
  }),
  contract({
    type: "AccessRequested", version: 1, aggregateType: "ACCESS_REQUEST", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "consent sharing (requestAccess: a doctor or facility asks the person)",
    payload: z.object({
      requestId: id, personId: id, requesterKind: z.enum(["DOCTOR", "FACILITY"]), requesterFacilityId: id, purpose: sharePurpose, categories: z.array(shareCategory).min(1),
    }).strict(),
  }),
  contract({
    type: "AccessRequestStatusChanged", version: 1, aggregateType: "ACCESS_REQUEST", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "consent sharing (approved or declined by the person, cancelled by the requester, expired, revoke-all)",
    payload: z.object({ requestId: id, personId: id, from: accessRequestStatus, to: accessRequestStatus, shareId: optId }).strict(),
  }),
  contract({
    // 4c answers: a notice to the person about access to their record (daily summary, break-glass, a waiting request).
    type: "PersonNotificationQueued", version: 1, aggregateType: "PERSON_NOTIFICATION", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "person notifications (the daily access-summary sweep; the person-notifier on BreakGlassStatusChanged and AccessRequested)",
    payload: z.object({ notificationId: id, personId: id, kind: z.enum(["ACCESS_SUMMARY", "BREAK_GLASS_ACCESS", "ACCESS_REQUESTED"]) }).strict(),
  }),
  contract({
    type: "PersonNotificationStatusChanged", version: 1, aggregateType: "PERSON_NOTIFICATION", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "person notifications (the person-notifier delivered it, found no channel, or failed)",
    payload: z.object({
      notificationId: id, personId: id, from: z.enum(["PENDING"]), to: z.enum(["SENT", "NO_CHANNEL", "FAILED"]), channel: z.enum(["EMAIL", "SMS"]).optional(),
    }).strict(),
  }),
  contract({
    type: "PersonAccessRevokedAll", version: 1, aggregateType: "PERSON", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "consent sharing (revokeAllAccess: the person's one-tap revoke)",
    payload: z.object({
      personId: id, sharesEnded: z.number().int().min(0), requestsDeclined: z.number().int().min(0), consentsRevoked: z.number().int().min(0), uploadsSharingDeclined: z.boolean(),
    }).strict(),
  }),
  contract({
    // Week 4b: a choice decided before the person turned 18 lapsed to "needs your confirmation" (decision 10).
    type: "PersonConsentLapsed", version: 1, aggregateType: "PERSON", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "person identity (sweepConsentLapses: the runner, on the 18th birthday)",
    payload: z.object({
      personId: id, consentId: id, purpose: z.enum(["SHARE_UPLOADS_WITH_TREATING", "DOCUMENT_PROCESSING", "AI_ASSISTANCE", "AI_TEXT_RETENTION"]), reason: z.enum(["TURNED_18"]),
    }).strict(),
  }),
  contract({
    // v2 (Week 4a): the purposes of the real-data switch, and scopes.
    type: "PersonConsentDecided", version: 2, aggregateType: "PERSON", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "person identity (decidePersonConsent: sharing uploads, document processing, AI assistance, AI text retention)",
    payload: z.object({
      personId: id, consentId: id, purpose: z.enum(["SHARE_UPLOADS_WITH_TREATING", "DOCUMENT_PROCESSING", "AI_ASSISTANCE", "AI_TEXT_RETENTION"]),
      decision: z.enum(["GRANTED", "DECLINED"]), previous: z.enum(["NONE", "GRANTED", "DECLINED"]), scopes: z.array(z.enum(["SAFETY_REVIEW"])),
    }).strict(),
  }),
  // ── Document pipeline (Week 4a) ───────────────────────────────────────────
  // PERSON-scoped: a Person's own documents belong to no facility. Ids, closed
  // codes and counts only: no text, values, names or languages beyond codes.
  contract({
    type: "DocumentPagesPrepared", version: 1, aggregateType: "DOCUMENT_PROCESSING", scope: "PERSON",
    sensitivity: "INTERNAL", producer: "document pipeline (doc-page-split: pages split from the upload; the original untouched)",
    payload: z.object({ processingId: id, documentId: id, personId: id, pageCount: z.number().int().min(1) }).strict(),
  }),
  contract({
    type: "DocumentTextExtracted", version: 1, aggregateType: "DOCUMENT_PROCESSING", scope: "PERSON",
    sensitivity: "INTERNAL", producer: "document pipeline (doc-ocr: text and language per page)",
    payload: z.object({
      processingId: id, documentId: id, personId: id, pageCount: z.number().int().min(1),
      languages: z.array(documentLanguage), handwritten: z.boolean(), confidenceBand,
    }).strict(),
  }),
  contract({
    type: "DocumentTranslated", version: 1, aggregateType: "DOCUMENT_PROCESSING", scope: "PERSON",
    sensitivity: "INTERNAL", producer: "document pipeline (doc-translate: protected values masked; a translation failing the exact-copy check is never shown)",
    payload: z.object({
      processingId: id, documentId: id, personId: id, targetLanguage: documentLanguage,
      translatedPages: z.number().int().min(0), exactCopyFailures: z.number().int().min(0), skipped: z.boolean(),
    }).strict(),
  }),
  contract({
    // v2 (Week 4b): Odia and Urdu.
    type: "DocumentTextExtracted", version: 2, aggregateType: "DOCUMENT_PROCESSING", scope: "PERSON",
    sensitivity: "INTERNAL", producer: "document pipeline (doc-ocr: text and language per page)",
    payload: z.object({
      processingId: id, documentId: id, personId: id, pageCount: z.number().int().min(1),
      languages: z.array(documentLanguageV2), handwritten: z.boolean(), confidenceBand,
    }).strict(),
  }),
  contract({
    // v2 (Week 4b): Odia and Urdu.
    type: "DocumentTranslated", version: 2, aggregateType: "DOCUMENT_PROCESSING", scope: "PERSON",
    sensitivity: "INTERNAL", producer: "document pipeline (doc-translate: protected values masked; a translation failing the exact-copy check is never shown)",
    payload: z.object({
      processingId: id, documentId: id, personId: id, targetLanguage: documentLanguageV2,
      translatedPages: z.number().int().min(0), exactCopyFailures: z.number().int().min(0), skipped: z.boolean(),
    }).strict(),
  }),
  contract({
    type: "DocumentProcessingFailed", version: 1, aggregateType: "DOCUMENT_PROCESSING", scope: "PERSON",
    sensitivity: "INTERNAL", producer: "document pipeline (any step: a permanent error, or retries exhausted; the original is kept)",
    payload: z.object({ processingId: id, documentId: id, personId: id, step: documentStep, errorCode: documentStepError }).strict(),
  }),
  contract({
    type: "DocumentFactsExtracted", version: 1, aggregateType: "DOCUMENT_PROCESSING", scope: "PERSON",
    sensitivity: "INTERNAL", producer: "document pipeline (doc-extract: facts from the original text, with confidence; the run awaits the person's review)",
    payload: z.object({ processingId: id, documentId: id, personId: id, factCount: z.number().int().min(0), lowConfidenceCount: z.number().int().min(0) }).strict(),
  }),
  contract({
    type: "DocumentProcessingCompleted", version: 1, aggregateType: "DOCUMENT_PROCESSING", scope: "PERSON",
    sensitivity: "INTERNAL", producer: "document pipeline (doc-extract with nothing to review; doc-merge once every fact is decided)",
    payload: z.object({ processingId: id, documentId: id, personId: id, confirmed: z.number().int().min(0), corrected: z.number().int().min(0), rejected: z.number().int().min(0) }).strict(),
  }),
  contract({
    type: "ExtractedFactReviewed", version: 1, aggregateType: "DOCUMENT_PROCESSING", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "document review (confirmFact, confirmFactField, correctFact, rejectFact, bulkReview: the person's own decision)",
    payload: z.object({ factId: id, processingId: id, personId: id, factType: extractedFactType, decision: z.enum(["CONFIRMED", "CORRECTED", "REJECTED"]), via: z.enum(["SELF", "PROXY"]) }).strict(),
  }),
  contract({
    type: "DocumentReprocessRequested", version: 1, aggregateType: "DOCUMENT_PROCESSING", scope: "PERSON",
    sensitivity: "INTERNAL", producer: "document review (requestReprocess: the person asked for a fresh run)",
    payload: z.object({ processingId: id, documentId: id, personId: id, reason: z.enum(["MODEL_UPGRADE", "PATIENT_REQUEST", "LANGUAGE_CHANGED"]) }).strict(),
  }),
  contract({
    type: "PatientProvidedRecordAdded", version: 1, aggregateType: "PATIENT_PROVIDED_RECORD", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "document pipeline (doc-merge: a confirmed or corrected fact becomes a patient-provided entry)",
    payload: z.object({ recordId: id, personId: id, kind: patientProvidedKind, factId: id, documentId: id }).strict(),
  }),
  contract({
    type: "PatientProvidedRecordUpdated", version: 1, aggregateType: "PATIENT_PROVIDED_RECORD", scope: "PERSON",
    sensitivity: "SENSITIVE", producer: "document pipeline (withdrawPatientRecord; the upload withdrawn; a re-run supersedes an entry)",
    payload: z.object({ recordId: id, personId: id, kind: patientProvidedKind, change: z.enum(["CORRECTED", "WITHDRAWN", "SUPERSEDED"]) }).strict(),
  }),
  contract({
    type: "RecordConflictDetected", version: 1, aggregateType: "RECORD_CONFLICT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "document pipeline (doc-conflicts: a patient-provided entry disagrees with this facility's verified record; nothing is overwritten)",
    payload: z.object({
      conflictId: id, personId: id, patientId: id, kind: patientProvidedKind, patientProvidedRecordId: id,
      verifiedSourceType: z.enum(["LabResult", "Allergy", "MedicationOrder", "Diagnosis"]), verifiedSourceId: id,
    }).strict(),
  }),
  contract({
    // v2 (Week 4b): a verified "no known allergies" status can be the other side (AllergyStatusEntry).
    type: "RecordConflictDetected", version: 2, aggregateType: "RECORD_CONFLICT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "document pipeline (doc-conflicts: a patient-provided entry disagrees with this facility's verified record; nothing is overwritten)",
    payload: z.object({
      conflictId: id, personId: id, patientId: id, kind: patientProvidedKind, patientProvidedRecordId: id,
      verifiedSourceType: z.enum(["LabResult", "Allergy", "AllergyStatusEntry", "MedicationOrder", "Diagnosis"]), verifiedSourceId: id,
    }).strict(),
  }),
  contract({
    type: "RecordConflictAcknowledged", version: 1, aggregateType: "RECORD_CONFLICT", scope: "FACILITY",
    sensitivity: "INTERNAL", producer: "document pipeline (acknowledgeConflict: a clinician saw it, or resolved it by recording a verified entry)",
    payload: z.object({ conflictId: id, patientId: id, status: z.enum(["ACKNOWLEDGED", "RESOLVED_BY_CLINICIAN"]), staffId: id }).strict(),
  }),
];

const KEY = (type: string, version: number) => `${type}@${version}`;

const BY_KEY = new Map<string, EventContract>();
const CURRENT_VERSION = new Map<string, number>();
for (const c of EVENT_CONTRACTS) {
  const k = KEY(c.type, c.version);
  if (BY_KEY.has(k)) throw new Error(`Duplicate event contract ${k}`);
  BY_KEY.set(k, c);
  CURRENT_VERSION.set(c.type, Math.max(CURRENT_VERSION.get(c.type) ?? 0, c.version));
}

/** Every known event type name. */
export const ALL_EVENT_TYPES = [...CURRENT_VERSION.keys()].sort();

/** Latest declared version for a type, or undefined if the type is unknown. */
export function currentVersion(type: string): number | undefined {
  return CURRENT_VERSION.get(type);
}

/** Look up an exact (type, version) contract, or undefined if not in the catalogue. */
export function getEventContract(type: string, version: number): EventContract | undefined {
  return BY_KEY.get(KEY(type, version));
}
