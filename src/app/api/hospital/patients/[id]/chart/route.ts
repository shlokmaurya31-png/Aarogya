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
    // Milestone E hardening — this returns the full clinical record (notes,
    // diagnoses, medication/lab/imaging orders including results), which
    // patient:read over-granted to FRONT_DESK/BILLING_STAFF (roles with no
    // other clinical permission). clinical:chart:read is the narrower gate.
    const { facilityId } = await requireFacilityStaff("clinical:chart:read", searchParams.get("facilityId") ?? undefined);
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

    // Milestone E hardening — these queries were previously unbounded
    // (unlike vitals/handoffs just below, which already had a `take`),
    // returning the patient's entire lifetime clinical record on every
    // chart load. Caps mirror the existing vitals/handoffs precedent in
    // this same file.
    const [notes, vitals, medicationOrders, labOrders, imagingOrders, diagnoses, carePlans, handoffs] = await Promise.all([
      prisma.clinicalNote.findMany({ where: { encounterId: { in: encounterIds } }, include: { author: { include: { user: true } } }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.vital.findMany({ where: { encounterId: { in: encounterIds } }, orderBy: { recordedAt: "desc" }, take: 50 }),
      prisma.medicationOrder.findMany({
        where: { encounterId: { in: encounterIds } },
        include: {
          orderedBy: { include: { user: true } },
          administrations: { orderBy: { scheduledAt: "desc" }, take: 20 },
          safetyWarnings: true,
          verifications: { orderBy: { createdAt: "desc" }, take: 1 },
          dispensingRecords: { orderBy: { createdAt: "desc" }, take: 20 },
        },
        orderBy: { orderedAt: "desc" },
        take: 50,
      }),
      prisma.labOrder.findMany({
        where: { encounterId: { in: encounterIds } },
        include: { results: { where: { isCurrent: true } }, specimens: { orderBy: { createdAt: "desc" }, take: 1 } },
        orderBy: { orderedAt: "desc" },
        take: 50,
      }),
      prisma.imagingOrder.findMany({
        where: { encounterId: { in: encounterIds } },
        include: { reports: { where: { isCurrent: true } }, studies: { orderBy: { createdAt: "desc" }, take: 1 } },
        orderBy: { orderedAt: "desc" },
        take: 50,
      }),
      prisma.diagnosis.findMany({ where: { encounterId: { in: encounterIds } }, orderBy: { createdAt: "desc" }, take: 50 }),
      prisma.carePlan.findMany({ where: { patientId: id }, include: { interventions: { orderBy: { createdAt: "desc" }, take: 20 } }, orderBy: { createdAt: "desc" }, take: 20 }),
      prisma.clinicalHandoff.findMany({ where: { patientId: id }, include: { fromStaff: { include: { user: true } }, toStaff: { include: { user: true } } }, orderBy: { createdAt: "desc" }, take: 10 }),
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
      diagnoses,
      encounters: patient.encounters,
      notes,
      vitals,
      medicationOrders,
      labOrders,
      imagingOrders,
      carePlans,
      handoffs,
    };
  });
}
