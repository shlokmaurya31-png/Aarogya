import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";

/**
 * Pharmacist verification queue (brief §17) — each entry carries the full
 * clinical context a pharmacist needs to make a real decision: allergies,
 * active problems, current medications, and this order's own safety
 * warnings, not just the bare order.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("medication:verify", searchParams.get("facilityId") ?? undefined);
    const status = searchParams.get("status") ?? "PHARMACY_REVIEW";

    const orders = await prisma.medicationOrder.findMany({
      where: { encounter: { facilityId }, status: status as never },
      include: {
        patient: { include: { allergies: true, problems: { where: { status: "active" } } } },
        orderedBy: { include: { user: true } },
        safetyWarnings: { where: { acknowledgedAt: null } },
        order: true,
      },
      orderBy: { orderedAt: "asc" },
      take: 100,
    });

    // Current medications for each patient (excluding this order itself) — duplicate/context check surface.
    const patientIds = [...new Set(orders.map((o) => o.patientId))];
    const currentMeds = await prisma.medicationOrder.findMany({
      where: { patientId: { in: patientIds }, status: { in: ["ACTIVE", "DISPENSED", "VERIFIED"] } },
      select: { id: true, patientId: true, drugName: true, dose: true, route: true, frequency: true },
    });
    const medsByPatient = new Map<string, typeof currentMeds>();
    for (const m of currentMeds) {
      const list = medsByPatient.get(m.patientId) ?? [];
      list.push(m);
      medsByPatient.set(m.patientId, list);
    }

    return {
      orders: orders.map((o) => ({ ...o, currentMedications: (medsByPatient.get(o.patientId) ?? []).filter((m) => m.id !== o.id) })),
    };
  });
}
