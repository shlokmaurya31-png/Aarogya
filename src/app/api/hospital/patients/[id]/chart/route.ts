import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, NotFoundError } from "@/lib/auth/rbac";

/**
 * The unified longitudinal patient record (brief §69/§108): every
 * encounter, note, order and result for this patient, queried across
 * encounter types rather than siloed per visit.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("patient:read", searchParams.get("facilityId") ?? undefined);
    const { id } = await params;

    const patient = await prisma.patient.findUnique({
      where: { id },
      include: {
        allergies: true,
        problems: { orderBy: { createdAt: "desc" } },
        encounters: {
          orderBy: { registeredAt: "desc" },
          include: {
            department: true,
            attendingStaff: { include: { user: true } },
            admission: { include: { bed: { include: { ward: true } }, discharge: true } },
          },
        },
      },
    });
    if (!patient || patient.facilityId !== facilityId) throw new NotFoundError("Patient not found.");

    const encounterIds = patient.encounters.map((e) => e.id);

    const [notes, vitals, medicationOrders, labOrders, imagingOrders] = await Promise.all([
      prisma.clinicalNote.findMany({ where: { encounterId: { in: encounterIds } }, include: { author: { include: { user: true } } }, orderBy: { createdAt: "desc" } }),
      prisma.vital.findMany({ where: { encounterId: { in: encounterIds } }, orderBy: { recordedAt: "desc" }, take: 50 }),
      prisma.medicationOrder.findMany({ where: { encounterId: { in: encounterIds } }, include: { orderedBy: { include: { user: true } }, administrations: true }, orderBy: { orderedAt: "desc" } }),
      prisma.labOrder.findMany({ where: { encounterId: { in: encounterIds } }, include: { result: true }, orderBy: { orderedAt: "desc" } }),
      prisma.imagingOrder.findMany({ where: { encounterId: { in: encounterIds } }, include: { report: true }, orderBy: { orderedAt: "desc" } }),
    ]);

    return {
      patient: {
        id: patient.id,
        uhid: patient.uhid,
        fullName: patient.fullName,
        sex: patient.sex,
        ageYears: patient.ageYears,
        phone: patient.phone,
        bloodGroup: patient.bloodGroup,
      },
      allergies: patient.allergies,
      problems: patient.problems,
      encounters: patient.encounters,
      notes,
      vitals,
      medicationOrders,
      labOrders,
      imagingOrders,
    };
  });
}
