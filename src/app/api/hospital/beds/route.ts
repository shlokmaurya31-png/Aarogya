import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    // Read-only listing uses patient:read (every clinical role has this), not bed:manage — DOCTOR needs to see
    // the bed board to select a bed when admitting, without being granted write access to bed state.
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);

    const beds = await prisma.bed.findMany({
      where: { facilityId },
      include: {
        ward: true,
        admissions: {
          where: { discharge: null },
          include: { encounter: { include: { patient: true } } },
          take: 1,
          orderBy: { admittedAt: "desc" },
        },
      },
      orderBy: [{ ward: { name: "asc" } }, { label: "asc" }],
    });

    return {
      beds: beds.map((b) => ({
        id: b.id,
        label: b.label,
        status: b.status,
        wardId: b.wardId,
        wardName: b.ward.name,
        wardType: b.ward.wardType,
        isolationRequired: b.isolationRequired,
        genderRestriction: b.genderRestriction,
        currentPatient: b.admissions[0]
          ? {
              patientId: b.admissions[0].encounter.patientId,
              name: b.admissions[0].encounter.patient.fullName,
              admissionId: b.admissions[0].id,
              reason: b.admissions[0].reason,
            }
          : null,
      })),
    };
  });
}
