import { prisma } from "@/lib/db";

/**
 * Operational patient-flow timeline for ONE encounter/visit (brief §48) —
 * distinct from src/lib/patient/timeline.ts's patient-level CLINICAL
 * timeline (every encounter's diagnoses/notes/orders across the whole
 * longitudinal record). This one answers "how did THIS visit move through
 * the building" — registration, check-in, queue, triage, consultation,
 * disposition — built from real state-transition timestamps already
 * written by the Phase 2 services, not a duplicated event table (same
 * computed-aggregation pattern as docs/CLINICAL_CORE.md §4).
 */
export interface FlowTimelineEntry {
  timestamp: string;
  label: string;
}

export async function buildEncounterFlowTimeline(encounterId: string): Promise<FlowTimelineEntry[]> {
  const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } });
  const [appointment, queueEntries, triageAssessments, admissionRequests, transferRequests, admission] = await Promise.all([
    prisma.appointment.findFirst({ where: { encounterId } }),
    prisma.queueEntry.findMany({ where: { encounterId }, orderBy: { enteredAt: "asc" } }),
    prisma.triageAssessment.findMany({ where: { encounterId }, orderBy: { createdAt: "asc" } }),
    prisma.admissionRequest.findMany({ where: { encounterId }, orderBy: { createdAt: "asc" } }),
    prisma.transferRequest.findMany({ where: { patientId: encounter.patientId }, orderBy: { createdAt: "asc" } }),
    prisma.admission.findUnique({ where: { encounterId }, include: { discharge: true } }),
  ]);

  const entries: FlowTimelineEntry[] = [];
  const push = (timestamp: Date | null | undefined, label: string) => {
    if (timestamp) entries.push({ timestamp: timestamp.toISOString(), label });
  };

  if (appointment) {
    push(appointment.createdAt, `Appointment booked (${appointment.type})`);
    push(appointment.cancelledAt, `Appointment cancelled${appointment.cancelledReason ? `: ${appointment.cancelledReason}` : ""}`);
    push(appointment.noShowAt, "Marked no-show");
  }
  push(encounter.registeredAt, `Registered (${encounter.type}${encounter.accessSource ? `, ${encounter.accessSource}` : ""})`);

  for (const q of queueEntries) {
    push(q.enteredAt, `Entered ${q.queueType.replace("_", " ").toLowerCase()} queue`);
    push(q.calledAt, `Called — ${q.queueType.replace("_", " ").toLowerCase()}`);
    push(q.startedAt, `Service started — ${q.queueType.replace("_", " ").toLowerCase()}`);
    push(q.completedAt, `Service completed — ${q.queueType.replace("_", " ").toLowerCase()}`);
  }

  for (const t of triageAssessments) {
    push(t.createdAt, `Triaged — acuity ${t.acuity}${t.assignedArea ? ` (${t.assignedArea})` : ""}`);
  }

  for (const ar of admissionRequests) {
    push(ar.createdAt, "Admission requested");
    push(ar.reviewedAt, ar.status === "REJECTED" ? `Admission request rejected: ${ar.rejectionReason ?? ""}` : "Bed allocated");
  }

  if (admission) {
    push(admission.admittedAt, `Admitted — bed reserved and occupied`);
    if (admission.discharge) {
      push(admission.discharge.initiatedAt, "Discharge planning initiated");
      push(admission.discharge.dischargedAt, "Discharged — bed released for cleaning");
    }
  }

  for (const tr of transferRequests) {
    push(tr.createdAt, "Transfer requested");
    push(tr.completedAt, "Transfer completed");
  }

  push(encounter.closedAt, encounter.status === "CANCELLED" ? `Encounter cancelled${encounter.cancelledReason ? `: ${encounter.cancelledReason}` : ""}` : "Encounter closed");

  return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
