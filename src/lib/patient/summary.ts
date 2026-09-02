import { prisma } from "@/lib/db";
import { resolvePatientIdsForRead } from "./merge";

/**
 * Server-side patient summary (brief §31) — aggregates only entities that
 * already exist in the schema. Deliberately does not fabricate sections
 * for capabilities not yet built (e.g. no "active care plans" section,
 * since CarePlan doesn't exist this phase — see docs/CLINICAL_CORE.md).
 */
export async function buildPatientSummary(patientId: string) {
  const patientIds = await resolvePatientIdsForRead(patientId);

  const [patient, activeProblems, activeAllergies, activeMedications, recentVitals, recentEncounters, pendingLabOrders, pendingImagingOrders, recentNotes] =
    await Promise.all([
      prisma.patient.findUnique({ where: { id: patientId }, include: { emergencyContacts: true, identifiers: true } }),
      prisma.problem.findMany({ where: { patientId: { in: patientIds }, status: "active" } }),
      prisma.allergy.findMany({ where: { patientId: { in: patientIds }, status: "ACTIVE" } }),
      prisma.medicationOrder.findMany({
        where: { patientId: { in: patientIds }, status: { in: ["ORDERED", "VERIFIED", "DISPENSED"] } },
        orderBy: { orderedAt: "desc" },
      }),
      prisma.vital.findMany({
        where: { encounter: { patientId: { in: patientIds } } },
        orderBy: { recordedAt: "desc" },
        take: 5,
      }),
      prisma.encounter.findMany({
        where: { patientId: { in: patientIds } },
        orderBy: { registeredAt: "desc" },
        take: 5,
        include: { department: true },
      }),
      prisma.labOrder.findMany({ where: { patientId: { in: patientIds }, status: { not: "RESULTED" } } }),
      prisma.imagingOrder.findMany({ where: { patientId: { in: patientIds }, status: { not: "REPORTED" } } }),
      prisma.clinicalNote.findMany({
        where: { encounter: { patientId: { in: patientIds } } },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { author: { include: { user: true } } },
      }),
    ]);

  return {
    patient,
    mergedPatientIds: patientIds.filter((id) => id !== patientId),
    activeProblems,
    activeAllergies,
    activeMedications,
    recentVitals,
    recentEncounters,
    pendingLabOrders,
    pendingImagingOrders,
    recentNotes,
  };
}
