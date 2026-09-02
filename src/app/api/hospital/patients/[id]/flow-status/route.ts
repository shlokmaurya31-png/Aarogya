import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";

/**
 * "Where is this patient?" (brief §33/§64/§70) — the operational
 * counterpart to Phase 1's clinical summary/timeline. Answers current
 * encounter, current queue position, current physical location, and
 * whether the patient is outpatient / in ED / admitted / discharged, all
 * from live state — never two simultaneous active inpatient bed
 * assignments, since `Admission.encounterId` is unique and an encounter
 * can only be ADMITTED once (brief §64).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const patient = await prisma.patient.findUnique({ where: { id } });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const activeEncounter = await prisma.encounter.findFirst({
      where: { patientId: id, status: { notIn: ["DISCHARGED", "CLOSED", "CANCELLED"] } },
      orderBy: { registeredAt: "desc" },
      include: {
        attendingStaff: { include: { user: true } },
        admission: { include: { bed: { include: { ward: true } } } },
        locations: { where: { releasedAt: null }, take: 1, include: { bed: { include: { ward: true } } } },
        queueEntries: { where: { status: { in: ["WAITING", "CALLED", "IN_SERVICE"] } }, orderBy: { enteredAt: "desc" }, take: 1 },
      },
    });

    if (!activeEncounter) {
      return { status: "NO_ACTIVE_ENCOUNTER", location: null, encounter: null };
    }

    const status = activeEncounter.admission ? "ADMITTED" : activeEncounter.type === "ED" ? "IN_ED" : "OUTPATIENT";
    const location = activeEncounter.admission
      ? `${activeEncounter.admission.bed.label} (${activeEncounter.admission.bed.ward.name})`
      : activeEncounter.locations[0]
        ? activeEncounter.locations[0].bed
          ? `${activeEncounter.locations[0].bed.label} (${activeEncounter.locations[0].bed.ward.name})`
          : activeEncounter.locations[0].areaLabel
        : null;

    return {
      status,
      location,
      encounter: {
        id: activeEncounter.id,
        type: activeEncounter.type,
        status: activeEncounter.status,
        attendingDoctor: activeEncounter.attendingStaff?.user.displayName ?? null,
      },
      currentQueue: activeEncounter.queueEntries[0]
        ? { queueType: activeEncounter.queueEntries[0].queueType, status: activeEncounter.queueEntries[0].status }
        : null,
    };
  });
}
