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
  | "hospital.billing.chargeCreated";

export async function recordAuditEvent(
  type: AuditEventType,
  userId: string | null,
  detail?: Record<string, unknown>
) {
  await prisma.auditEvent.create({
    data: { type, userId: userId ?? undefined, detail: detail ? JSON.parse(JSON.stringify(detail)) : undefined },
  });
}
