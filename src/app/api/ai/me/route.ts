import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession, withApiErrors } from "@/lib/auth/rbac";
import { roleHasPermission } from "@/lib/auth/permissions";
import { selfPatientIds } from "@/lib/person/self";
import { ownedPersonId } from "@/lib/person/access";
import { getCurrentUser } from "@/lib/auth/getCurrentUser";

/**
 * Week 4b — what the AI panels need to know about the caller: the modes their
 * role may use; a patient's own records (one per linked facility) and
 * language; for staff with ?patientId=, that patient's next appointment with
 * them (the visit brief's reason). Never another person's data: access is
 * decided again on every ask.
 */
const STAFF_MODES: Record<string, string[]> = { DOCTOR: ["VISIT_BRIEF", "CHART_QA", "HEALTH_TIMELINE"], NURSE: ["CHART_QA", "NURSE_HANDOFF"] };

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role === "PATIENT") {
      const ids = await selfPatientIds(session.userId);
      const personId = await ownedPersonId(session.userId);
      const [patients, person] = await Promise.all([
        prisma.patient.findMany({ where: { id: { in: ids } }, select: { id: true, facility: { select: { name: true } } } }),
        personId ? prisma.person.findUnique({ where: { id: personId }, select: { preferredLanguage: true } }) : null,
      ]);
      return { audience: "PATIENT", modes: ["EXPLAIN_REPORT", "HEALTH_TIMELINE", "PREVISIT_QUESTIONS"], patients: patients.map((p) => ({ patientId: p.id, facilityName: p.facility.name })), language: person?.preferredLanguage ?? "en" };
    }
    if (!roleHasPermission(session.role, "ai:record:ask")) return { audience: "NONE", modes: [] };
    const patientId = new URL(req.url).searchParams.get("patientId");
    let appointmentId: string | null = null;
    if (patientId) {
      const user = await getCurrentUser();
      const staffId = user?.hospitalStaffProfile?.id;
      const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
      const next = staffId ? await prisma.appointment.findFirst({ where: { patientId, doctorStaffId: staffId, scheduledStart: { gte: startOfDay }, status: { notIn: ["CANCELLED", "NO_SHOW", "COMPLETED"] } }, orderBy: { scheduledStart: "asc" }, select: { id: true } }) : null;
      appointmentId = next?.id ?? null;
    }
    return { audience: "STAFF", modes: STAFF_MODES[session.role] ?? [], appointmentId };
  });
}
