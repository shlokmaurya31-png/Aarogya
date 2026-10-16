import { z } from "zod";
import type { EventContract } from "./types";

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
const resuscitationStatus = z.enum(["ACTIVATED", "ACTIVE", "STABILIZED", "HANDED_OVER", "DISPOSITION_PENDING", "CLOSED"]);
const transferRequestStatus = z.enum(["REQUESTED", "ACCEPTED", "BED_RESERVED", "PATIENT_IN_TRANSIT", "COMPLETED", "CANCELLED", "REJECTED"]);

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
    type: "StockLotStatusChanged", version: 1, aggregateType: "ITEM_LOT", scope: "FACILITY",
    sensitivity: "LOW", producer: "inventory lots (quarantineLot, releaseLotFromQuarantine), pharmacy recalls",
    payload: z.object({ lotId: id, itemId: id, from: lotStatus, to: lotStatus, cause: z.enum(["QUARANTINE", "RELEASE", "RECALL"]), recallId: optId }).strict(),
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
