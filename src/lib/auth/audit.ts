import { prisma } from "@/lib/db";

export type AuditEventType =
  | "student.verification.submitted"
  | "student.verification.approved"
  | "student.verification.rejected"
  | "student.case.opened"
  | "student.case.action"
  | "student.case.submitted"
  | "student.permission.denied"
  | "educator.case.created"
  | "admin.verification.reviewed"
  // Hospital OS — see docs/ENTERPRISE_HOSPITAL_ARCHITECTURE.md §5.
  | "hospital.patient.registered"
  | "hospital.encounter.registered"
  | "hospital.encounter.updated"
  | "hospital.vital.recorded"
  | "hospital.note.created"
  | "hospital.bed.stateChanged"
  | "hospital.bed.cleaned"
  | "hospital.admission.created"
  | "hospital.admission.transferred"
  | "hospital.discharge.initiated"
  | "hospital.discharge.finalized"
  | "hospital.medication.ordered"
  | "hospital.medication.administered"
  | "hospital.lab.ordered"
  | "hospital.lab.resultReleased"
  | "hospital.lab.criticalResultAcknowledged"
  | "hospital.imaging.ordered"
  | "hospital.imaging.reportEntered"
  | "hospital.imaging.criticalReportVerified"
  | "hospital.billing.chargeCreated"
  // Phase 1 — Unified Clinical Core. Named to match the target event
  // catalog in docs/EVENT_ARCHITECTURE.md §4 (PATIENT_CREATED-style),
  // recorded today via the existing synchronous AuditEvent mechanism, not
  // a new event bus — see docs/CLINICAL_CORE.md §6.
  | "hospital.patient.created"
  | "hospital.patient.updated"
  | "hospital.patient.merged"
  | "hospital.patient.viewed"
  | "hospital.encounter.cancelled"
  | "hospital.diagnosis.added"
  | "hospital.problem.added"
  | "hospital.allergy.added"
  | "hospital.episode.created"
  | "hospital.episode.closed"
  | "hospital.task.created"
  | "hospital.task.completed"
  | "hospital.document.created"
  | "hospital.consent.recorded"
  | "hospital.consent.revoked"
  | "hospital.referral.created"
  | "hospital.referral.updated"
  | "patient.account.registered"
  // Phase 2 — Patient Flow / ADT. Named to match the brief §59 event
  // catalog; recorded through the same synchronous AuditEvent mechanism
  // (docs/EVENT_ARCHITECTURE.md — no new event bus this phase either).
  | "hospital.appointment.created"
  | "hospital.appointment.cancelled"
  | "hospital.appointment.noShow"
  | "hospital.appointment.checkedIn"
  | "hospital.queue.entered"
  | "hospital.queue.priorityChanged"
  | "hospital.queue.called"
  | "hospital.queue.completed"
  | "hospital.triage.recorded"
  | "hospital.consultation.started"
  | "hospital.consultation.completed"
  | "hospital.admissionRequest.created"
  | "hospital.admissionRequest.bedReserved"
  | "hospital.admissionRequest.confirmed"
  | "hospital.admissionRequest.rejected"
  | "hospital.admissionRequest.cancelled"
  | "hospital.transferRequest.created"
  | "hospital.transferRequest.accepted"
  | "hospital.transferRequest.bedReserved"
  | "hospital.transferRequest.completed"
  | "hospital.transferRequest.cancelled"
  | "hospital.discharge.blockerChanged"
  | "hospital.discharge.expectedDateChanged"
  | "hospital.location.assigned"
  // Phase 3 — Doctor OS / Nursing OS / Medication Lifecycle / Pharmacy.
  // Recorded through the same synchronous AuditEvent mechanism as every
  // prior phase — no new event bus (brief §34/§27).
  | "hospital.note.signed"
  | "hospital.note.amended"
  | "hospital.order.created"
  | "hospital.order.cancelled"
  | "hospital.order.discontinued"
  | "hospital.medication.statusChanged"
  | "hospital.medication.verified"
  | "hospital.medication.rejected"
  | "hospital.medication.held"
  | "hospital.medication.clarificationRequested"
  | "hospital.medication.dispensed"
  | "hospital.medication.cancelled"
  | "hospital.medication.discontinued"
  | "hospital.medication.refused"
  | "hospital.medication.missed"
  | "hospital.medication.safetyOverridden"
  | "hospital.medication.reconciled"
  | "hospital.nursing.assignmentChanged"
  | "hospital.task.skipped"
  | "hospital.handoff.created"
  | "hospital.handoff.acknowledged"
  | "hospital.carePlan.created"
  | "hospital.carePlan.closed"
  | "hospital.consult.accepted"
  | "hospital.consult.completed"
  | "hospital.vital.abnormalDetected"
  // Phase 4 Milestone B — Laboratory core workflow (specimen lifecycle +
  // structured result entry/verification/amendment). Recorded through the
  // same synchronous AuditEvent mechanism as every prior phase.
  | "hospital.lab.specimenCollected"
  | "hospital.lab.specimenReceived"
  | "hospital.lab.specimenAccepted"
  | "hospital.lab.specimenRejected"
  | "hospital.lab.specimenRecollected"
  | "hospital.lab.resultEntered"
  | "hospital.lab.resultVerified"
  | "hospital.lab.resultAmended"
  // Phase 4 Milestone C — Radiology core workflow (study scheduling/
  // execution + structured report entry/verification/acknowledgement/
  // amendment). Recorded through the same synchronous AuditEvent
  // mechanism as every prior phase.
  | "hospital.imaging.scheduled"
  | "hospital.imaging.rescheduled"
  | "hospital.imaging.studyCancelled"
  | "hospital.imaging.studyCheckedIn"
  | "hospital.imaging.studyStarted"
  | "hospital.imaging.studyCompleted"
  | "hospital.imaging.reportVerified"
  | "hospital.imaging.criticalFindingAcknowledged"
  | "hospital.imaging.reportAmended";

export async function recordAuditEvent(
  type: AuditEventType,
  userId: string | null,
  detail?: Record<string, unknown>
) {
  await prisma.auditEvent.create({
    data: { type, userId: userId ?? undefined, detail: detail ? JSON.parse(JSON.stringify(detail)) : undefined },
  });
}
