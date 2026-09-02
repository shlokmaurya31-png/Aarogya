import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";

const VITALS_DUE_HOURS = 4;

/** Nursing task engine (brief §23): medication rounds + vitals due, computed from real order/encounter data rather than a static checklist. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const now = new Date();

    const dueMeds = await prisma.medicationAdministration.findMany({
      where: {
        status: "DUE",
        scheduledAt: { lte: now },
        medicationOrder: { encounter: { facilityId, status: "ADMITTED" } },
      },
      include: { medicationOrder: { include: { patient: true, encounter: { include: { admission: { include: { bed: true } } } } } } },
      orderBy: { scheduledAt: "asc" },
      take: 50,
    });

    const admittedEncounters = await prisma.encounter.findMany({
      where: { facilityId, status: "ADMITTED" },
      include: { patient: true, admission: { include: { bed: true } }, vitals: { orderBy: { recordedAt: "desc" }, take: 1 } },
    });
    const vitalsDue = admittedEncounters.filter((e) => {
      const last = e.vitals[0];
      if (!last) return true;
      return now.getTime() - last.recordedAt.getTime() >= VITALS_DUE_HOURS * 3_600_000;
    });

    return {
      medicationTasks: dueMeds.map((m) => ({
        administrationId: m.id,
        medicationOrderId: m.medicationOrderId,
        patientName: m.medicationOrder.patient.fullName,
        bedLabel: m.medicationOrder.encounter.admission?.bed.label ?? "—",
        drug: m.medicationOrder.drugName,
        dose: m.medicationOrder.dose,
        route: m.medicationOrder.route,
        scheduledAt: m.scheduledAt,
      })),
      vitalsTasks: vitalsDue.map((e) => ({
        encounterId: e.id,
        patientName: e.patient.fullName,
        bedLabel: e.admission?.bed.label ?? "—",
        lastRecordedAt: e.vitals[0]?.recordedAt ?? null,
      })),
    };
  });
}
