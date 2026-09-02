import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";

/**
 * Real-time ED board (brief §21) — every column/card value is a live
 * query, not a decorative mock. Column = latest TriageAssessment.assignedArea
 * (falling back to "TRIAGE_PENDING" for an ED encounter with none yet).
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const encounters = await prisma.encounter.findMany({
      where: { facilityId, type: "ED", status: { notIn: ["DISCHARGED", "CLOSED", "CANCELLED"] } },
      include: {
        patient: true,
        attendingStaff: { include: { user: true } },
        triageAssessments: { orderBy: { createdAt: "desc" }, take: 1 },
        locations: { where: { releasedAt: null }, take: 1, include: { bed: { include: { ward: true } } } },
        queueEntries: { where: { status: { in: ["WAITING", "CALLED", "IN_SERVICE"] } }, take: 1 },
        labOrders: { where: { status: { notIn: ["RESULTED", "CANCELLED"] } } },
        imagingOrders: { where: { status: { notIn: ["REPORTED", "CANCELLED"] } } },
        admissionRequests: { where: { status: { notIn: ["ADMITTED", "REJECTED", "CANCELLED"] } }, take: 1 },
      },
      orderBy: { registeredAt: "asc" },
    });

    const cards = encounters.map((e) => {
      const triage = e.triageAssessments[0];
      const location = e.locations[0];
      return {
        encounterId: e.id,
        patientId: e.patient.id,
        patientName: e.patient.fullName,
        uhid: e.patient.uhid,
        registeredAt: e.registeredAt,
        triageAcuity: triage?.acuity ?? e.triageLevel ?? null,
        column: triage?.assignedArea ?? "TRIAGE_PENDING",
        location: location ? (location.bed ? `${location.bed.label} (${location.bed.ward.name})` : location.areaLabel) : null,
        attendingDoctor: e.attendingStaff?.user.displayName ?? null,
        waitMinutes: Math.round((Date.now() - e.registeredAt.getTime()) / 60_000),
        pendingLabOrders: e.labOrders.length,
        pendingImagingOrders: e.imagingOrders.length,
        admissionPending: e.admissionRequests.length > 0,
        status: e.status,
        chiefComplaint: e.chiefComplaint,
      };
    });

    const columns = ["RESUSCITATION", "HIGH_PRIORITY", "STANDARD", "OBSERVATION", "TRIAGE_PENDING"];
    const byColumn = Object.fromEntries(columns.map((c) => [c, cards.filter((card) => card.column === c)]));
    return { cards, byColumn };
  });
}
