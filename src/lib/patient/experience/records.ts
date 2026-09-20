import { prisma } from "@/lib/db";
import { buildPatientTimeline } from "../timeline";
import { patientLanguage as L } from "./language";
import { assertClass, type PatientAccessScope } from "../context";

/**
 * Phase D11 — patient longitudinal record view (brief §16, §53).
 *
 * A PROJECTION, never a PatientRecord copy. Assembles a patient-safe view over
 * canonical tables: visits, active problems, allergies, admissions, and a
 * bounded chronological timeline (reusing the canonical timeline builder). The
 * merge-aware id set (scope.patientIds) means a merged history is included, and
 * nothing here is exposed unless the caller holds the RECORDS class.
 */

export interface RecordsDTO {
  visits: { date: string; department: string | null; statusLabel: string; reason: string | null }[];
  problems: { name: string; since: string | null }[];
  allergies: { substance: string; reaction: string | null; severity: string | null }[];
  timeline: { timestamp: string; type: string; summary: string; department: string | null }[];
}

export async function buildRecords(scope: PatientAccessScope): Promise<RecordsDTO> {
  assertClass(scope, "RECORDS");
  const [encounters, problems, allergies, timeline] = await Promise.all([
    prisma.encounter.findMany({
      where: { patientId: { in: scope.patientIds } },
      orderBy: { registeredAt: "desc" },
      take: 50,
      include: { department: { select: { name: true } } },
    }),
    prisma.problem.findMany({
      where: { patientId: { in: scope.patientIds }, status: "active" },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.allergy.findMany({
      where: { patientId: { in: scope.patientIds }, status: "ACTIVE" },
      orderBy: { recordedAt: "desc" },
      take: 100,
    }),
    // Timeline builder is already merge-aware; scope it to the primary id.
    buildPatientTimeline(scope.patientId),
  ]);

  return {
    visits: encounters.map((e) => ({
      date: e.registeredAt.toISOString(),
      department: e.department?.name ?? null,
      statusLabel: L.encounterStatus(e.status),
      reason: e.chiefComplaint ?? null,
    })),
    problems: problems.map((p) => ({ name: p.diagnosis, since: p.onsetDate?.toISOString() ?? p.createdAt.toISOString() })),
    allergies: allergies.map((a) => ({ substance: a.substance, reaction: a.reaction ?? null, severity: a.severity ?? null })),
    timeline: timeline.slice(0, 100).map((t) => ({
      timestamp: t.timestamp,
      type: t.type,
      summary: t.summary,
      department: t.department ?? null,
    })),
  };
}
