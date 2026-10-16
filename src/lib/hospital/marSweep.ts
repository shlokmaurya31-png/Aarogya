import { prisma } from "@/lib/db";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { facilityOrganizationId } from "@/lib/events/tenant";
import { resolveEffectiveInternal } from "@/lib/config/resolver";
import { SWEPT_MISSED_REASON } from "./medicationLifecycle";

/** Order statuses whose unrecorded doses count as missed (held or stopped drugs don't). */
const GIVING = ["VERIFIED", "DISPENSED", "ACTIVE"] as const;

/** `mar.missed_grace` (seconds, default 3600): how long after its time a dose may still be recorded before it counts as missed. */
export async function missedGraceSeconds(facilityId: string): Promise<number> {
  const organizationId = await facilityOrganizationId(prisma, facilityId);
  const { value } = await resolveEffectiveInternal({ key: "mar.missed_grace", organizationId, facilityId });
  return typeof value === "number" && value >= 0 ? value : 3600;
}

export interface SweepResult {
  missed: number;
}

/**
 * Workflow spine §3.4: marks DUE doses whose time + grace has passed as MISSED
 * (reasonCode "not-recorded") and emits MedicationDoseMissed (missedBy SWEEP),
 * one transaction per dose, with a guarded update (status = DUE), so a nurse
 * recording the dose at the same moment wins or loses cleanly and two sweeps
 * never both mark it. A nurse can still record the dose late: that writes a
 * new linked row (administerMedication), the missed fact stays.
 *
 * Only regular doses of orders still being given: PRN orders and held,
 * stopped or completed orders are skipped. Grace is resolved per facility
 * (configuration key `mar.missed_grace`).
 */
export async function sweepMedicationSchedule(opts: { now?: Date; batchSize?: number } = {}): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  let budget = opts.batchSize ?? 500;
  const facilities = await prisma.$queryRaw<{ facilityId: string }[]>`
    SELECT DISTINCT e."facilityId"
      FROM "MedicationAdministration" ma
      JOIN "MedicationOrder" mo ON mo.id = ma."medicationOrderId"
      JOIN "Encounter" e ON e.id = mo."encounterId"
     WHERE ma.status = 'DUE' AND ma."scheduledAt" < ${now}
     ORDER BY 1`;

  let missed = 0;
  for (const { facilityId } of facilities) {
    if (budget <= 0) break;
    const cutoff = new Date(now.getTime() - (await missedGraceSeconds(facilityId)) * 1000);
    const due = await prisma.medicationAdministration.findMany({
      where: {
        status: "DUE", scheduledAt: { lt: cutoff },
        medicationOrder: { prn: false, status: { in: [...GIVING] }, encounter: { facilityId } },
      },
      orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
      take: budget,
      select: { id: true, scheduledAt: true, medicationOrderId: true, medicationOrder: { select: { patientId: true, encounterId: true } } },
    });
    budget -= due.length;
    for (const dose of due) {
      const marked = await prisma.$transaction(async (tx) => {
        const r = await tx.medicationAdministration.updateMany({ where: { id: dose.id, status: "DUE" }, data: { status: "MISSED", reasonCode: SWEPT_MISSED_REASON } });
        if (r.count !== 1) return false; // recorded, or swept, concurrently
        await emitFacilityEvent(tx, {
          type: "MedicationDoseMissed", aggregateId: dose.id, facilityId, encounterId: dose.medicationOrder.encounterId,
          payload: {
            administrationId: dose.id, orderId: dose.medicationOrderId, patientId: dose.medicationOrder.patientId,
            encounterId: dose.medicationOrder.encounterId, scheduledAt: dose.scheduledAt.toISOString(), missedBy: "SWEEP",
          },
        });
        return true;
      });
      if (marked) missed += 1;
    }
  }
  return { missed };
}
