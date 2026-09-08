import { prisma } from "@/lib/db";

export type FlowsheetEntry = {
  type: "VITAL" | "IO" | "MEDICATION_ADMINISTRATION" | "TASK" | "CARE_PLAN_INTERVENTION";
  timestamp: Date;
  actorStaffId: string | null;
  summary: string;
  refId: string;
};

/**
 * Read-only composition layer (brief §8/§28): aggregates the existing
 * canonical records for an encounter into one timestamp-sorted timeline.
 * This is presentation only — no new clinical record is created or stored;
 * every entry links back (`refId`) to its source row (Vital,
 * IntakeOutputRecord, MedicationAdministration, Task, CarePlanIntervention).
 */
export async function buildFlowsheet(encounterId: string): Promise<FlowsheetEntry[]> {
  const [vitals, ioRecords, administrations, tasks, interventions] = await Promise.all([
    prisma.vital.findMany({ where: { encounterId } }),
    prisma.intakeOutputRecord.findMany({ where: { encounterId } }),
    prisma.medicationAdministration.findMany({
      where: { medicationOrder: { encounterId }, administeredAt: { not: null } },
      include: { medicationOrder: true },
    }),
    prisma.task.findMany({ where: { encounterId, status: "COMPLETED" } }),
    prisma.carePlanIntervention.findMany({
      where: { carePlan: { encounterId }, status: "COMPLETED", completedAt: { not: null } },
    }),
  ]);

  const entries: FlowsheetEntry[] = [];

  for (const v of vitals) {
    entries.push({
      type: "VITAL",
      timestamp: v.recordedAt,
      actorStaffId: v.recordedByStaffId,
      summary: `HR ${v.hr ?? "-"} · BP ${v.sbp ?? "-"}/${v.dbp ?? "-"} · RR ${v.rr ?? "-"} · SpO2 ${v.spo2 ?? "-"}% · Temp ${v.tempC ?? "-"}°C`,
      refId: v.id,
    });
  }

  for (const io of ioRecords) {
    entries.push({
      type: "IO",
      timestamp: io.recordedAt,
      actorStaffId: io.recordedByStaffId,
      summary: `${io.ioType} · ${io.category} · ${io.quantityMl}mL`,
      refId: io.id,
    });
  }

  for (const admin of administrations) {
    entries.push({
      type: "MEDICATION_ADMINISTRATION",
      timestamp: admin.administeredAt as Date,
      actorStaffId: admin.administeredByStaffId,
      summary: `${admin.medicationOrder.drugName} ${admin.medicationOrder.dose} — ${admin.status}`,
      refId: admin.id,
    });
  }

  for (const task of tasks) {
    entries.push({
      type: "TASK",
      timestamp: task.completedAt as Date,
      actorStaffId: task.completedByStaffId,
      summary: task.title,
      refId: task.id,
    });
  }

  for (const intervention of interventions) {
    entries.push({
      type: "CARE_PLAN_INTERVENTION",
      timestamp: intervention.completedAt as Date,
      actorStaffId: null,
      summary: intervention.description,
      refId: intervention.id,
    });
  }

  entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return entries;
}
