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
  | "patient.account.registered";

export async function recordAuditEvent(
  type: AuditEventType,
  userId: string | null,
  detail?: Record<string, unknown>
) {
  await prisma.auditEvent.create({
    data: { type, userId: userId ?? undefined, detail: detail ? JSON.parse(JSON.stringify(detail)) : undefined },
  });
}
