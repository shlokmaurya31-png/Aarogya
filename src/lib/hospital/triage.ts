import { prisma } from "@/lib/db";
import { isEncounterTransitionAllowed } from "./encounterStateMachine";
import { parseOptionalEnum } from "@/lib/enumValue";
import { $Enums } from "@prisma/client";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

/**
 * Records a triage assessment (brief §19-20). The clinician/nurse records
 * the acuity — this never determines it autonomously. Writes the full
 * auditable `TriageAssessment` row AND updates `Encounter.triageLevel`
 * (the denormalized "current" cache existing ED-order-routing code
 * already reads), and advances the encounter to TRIAGED when that's a
 * legal transition from its current state (REGISTERED -> TRIAGED; a
 * re-triage on an encounter already past TRIAGED just records the new
 * assessment without forcing the status backwards).
 */
export async function recordTriage(input: {
  encounterId: string;
  recordedByStaffId: string;
  acuity: number;
  chiefComplaint?: string;
  redFlags?: string;
  assignedArea?: string;
  notes?: string;
  byUserId: string;
  // Phase B5 — optional ED triage lifecycle + documentary fields (all additive;
  // omitting them preserves the exact Phase 2 behaviour).
  status?: "DRAFT" | "COMPLETED" | "AMENDED";
  amendsId?: string;
  presentingSymptoms?: string;
  allergySummary?: string;
  currentMedications?: string;
  relevantHistory?: string;
  painScore?: number;
  mentalStatus?: string;
  mobility?: string;
  pregnancyStatus?: string;
  isolationRequired?: boolean;
  injuryTrauma?: boolean;
}) {
  if (input.acuity < 1 || input.acuity > 5) throw new Error("Acuity must be between 1 and 5.");

  return prisma.$transaction(async (tx) => {
    const encounter = await tx.encounter.findUniqueOrThrow({ where: { id: input.encounterId } });

    const assessment = await tx.triageAssessment.create({
      data: {
        encounterId: input.encounterId,
        facilityId: encounter.facilityId,
        recordedByStaffId: input.recordedByStaffId,
        acuity: input.acuity,
        chiefComplaint: input.chiefComplaint,
        redFlags: input.redFlags,
        assignedArea: input.assignedArea,
        notes: input.notes,
        status: input.status ?? "COMPLETED",
        amendsId: input.amendsId,
        presentingSymptoms: input.presentingSymptoms,
        allergySummary: input.allergySummary,
        currentMedications: input.currentMedications,
        relevantHistory: input.relevantHistory,
        painScore: input.painScore,
        mentalStatus: parseOptionalEnum($Enums.AvpuScale, input.mentalStatus, "mentalStatus"),
        mobility: input.mobility,
        pregnancyStatus: parseOptionalEnum($Enums.PregnancyStatus, input.pregnancyStatus, "pregnancyStatus"),
        isolationRequired: input.isolationRequired ?? false,
        injuryTrauma: input.injuryTrauma ?? false,
      },
    });

    const updateData: { triageLevel: number; status?: "TRIAGED" } = { triageLevel: input.acuity };
    // A DRAFT triage does not advance the encounter — only a COMPLETED/AMENDED one does.
    if (input.status !== "DRAFT" && isEncounterTransitionAllowed(encounter.status, "TRIAGED")) {
      updateData.status = "TRIAGED";
    }
    await tx.encounter.update({ where: { id: input.encounterId }, data: updateData });
    // A draft is not a triage decision; only COMPLETED/AMENDED assessments are events.
    if (assessment.status !== "DRAFT") {
      await emitFacilityEvent(tx, {
        type: "PatientTriaged", aggregateId: input.encounterId, facilityId: encounter.facilityId, actorUserId: input.byUserId, encounterId: input.encounterId,
        payload: { triageId: assessment.id, encounterId: input.encounterId, patientId: encounter.patientId, acuity: input.acuity },
      });
    }

    await tx.auditEvent.create({
      data: { type: "hospital.triage.recorded", userId: input.byUserId, detail: { encounterId: input.encounterId, acuity: input.acuity, assignedArea: input.assignedArea } },
    });

    return assessment;
  });
}
