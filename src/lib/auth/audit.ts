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
  | "admin.verification.reviewed";

export async function recordAuditEvent(
  type: AuditEventType,
  userId: string | null,
  detail?: Record<string, unknown>
) {
  await prisma.auditEvent.create({
    data: { type, userId: userId ?? undefined, detail: detail ? JSON.parse(JSON.stringify(detail)) : undefined },
  });
}
