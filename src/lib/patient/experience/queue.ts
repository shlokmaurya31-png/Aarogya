import { prisma } from "@/lib/db";
import { patientLanguage as L } from "./language";
import { assertClass, type PatientAccessScope } from "../context";

/**
 * Phase D11 — patient-facing queue position (brief §10). Shows ONLY the
 * patient's own live queue entries and a POSITION ESTIMATE — never an exact
 * promised wait time, and never any other patient's identity or data. The
 * estimate is the number of not-yet-served entries ahead of them in the same
 * queue (lower priorityScore, or equal score and earlier arrival), computed
 * with a bounded aggregate query.
 */

const AHEAD_STATUSES = ["WAITING", "CALLED"];

export interface QueuePositionDTO {
  queueLabel: string;
  statusLabel: string;
  department: string | null;
  positionEstimate: number | null; // null when not meaningfully computable
  enteredAt: string;
}

const QUEUE_LABELS: Record<string, string> = {
  REGISTRATION: "Registration",
  TRIAGE: "Triage",
  OPD_DOCTOR: "Doctor's queue",
  ED: "Emergency",
};

export async function listQueuePositions(scope: PatientAccessScope): Promise<QueuePositionDTO[]> {
  assertClass(scope, "QUEUE");
  const entries = await prisma.queueEntry.findMany({
    where: { patientId: { in: scope.patientIds }, status: { in: AHEAD_STATUSES } },
    orderBy: { enteredAt: "asc" },
  });

  const out: QueuePositionDTO[] = [];
  for (const e of entries) {
    // Count entries genuinely ahead in the SAME queue — aggregate only, no
    // identities leave the database.
    let positionEstimate: number | null = null;
    if (e.status === "WAITING") {
      const ahead = await prisma.queueEntry.count({
        where: {
          facilityId: e.facilityId,
          queueType: e.queueType,
          departmentId: e.departmentId,
          status: { in: AHEAD_STATUSES },
          OR: [
            { priorityScore: { lt: e.priorityScore } },
            { priorityScore: e.priorityScore, enteredAt: { lt: e.enteredAt } },
          ],
        },
      });
      positionEstimate = ahead + 1; // 1-based: "you are Nth in line"
    }
    out.push({
      queueLabel: QUEUE_LABELS[e.queueType] ?? L.humanize(e.queueType),
      statusLabel: L.queueStatus(e.status),
      department: null,
      positionEstimate,
      enteredAt: e.enteredAt.toISOString(),
    });
  }
  return out;
}
