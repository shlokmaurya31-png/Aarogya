import type { Prisma, DischargeHoldReason } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

type Tx = Prisma.TransactionClient;

/**
 * Manual discharge holds (batch 6, fix 1). A person places a hold with a
 * reason code and clears it; while any hold is active, finalizeDischarge
 * refuses, whatever the readiness flags say. The discharge-readiness consumer
 * may raise derived flags but never touches a hold. Placing locks the
 * discharge row, as finalizeDischarge does, so a hold placed while a discharge
 * is being finalized either lands first (and blocks it) or sees it discharged.
 */
export class DischargeOnHoldError extends ConflictError {
  constructor(reasons: string[]) {
    super(`Discharge is on hold: ${reasons.join(", ")}. Clear the hold first.`);
  }
}

/** Lock the discharge row for the rest of the transaction. */
export async function lockDischarge(tx: Tx, dischargeId: string) {
  await tx.$queryRaw`SELECT id FROM "Discharge" WHERE id = ${dischargeId} FOR UPDATE`;
}

export async function activeHoldReasons(tx: Tx, dischargeId: string): Promise<string[]> {
  return (await tx.dischargeHold.findMany({ where: { dischargeId, clearedAt: null }, select: { reasonCode: true }, orderBy: { placedAt: "asc" } })).map((h) => h.reasonCode);
}

async function emitHold(tx: Tx, hold: { id: string; dischargeId: string; reasonCode: string }, change: "PLACED" | "CLEARED", byUserId: string) {
  const d = await tx.discharge.findUniqueOrThrow({ where: { id: hold.dischargeId }, select: { admission: { select: { id: true, encounter: { select: { id: true, facilityId: true, patientId: true } } } } } });
  const enc = d.admission.encounter;
  await emitFacilityEvent(tx, {
    type: "DischargeHoldChanged", aggregateId: hold.dischargeId, facilityId: enc.facilityId, encounterId: enc.id, actorUserId: byUserId,
    payload: { holdId: hold.id, dischargeId: hold.dischargeId, admissionId: d.admission.id, encounterId: enc.id, patientId: enc.patientId, change, reasonCode: hold.reasonCode },
  });
  return enc;
}

export async function placeDischargeHold(input: { dischargeId: string; facilityId: string; reasonCode: DischargeHoldReason; byUserId: string }) {
  const { hold, enc } = await prisma.$transaction(async (tx) => {
    await lockDischarge(tx, input.dischargeId);
    const discharge = await tx.discharge.findUnique({ where: { id: input.dischargeId }, select: { dischargedAt: true, admission: { select: { encounter: { select: { facilityId: true } } } } } });
    if (!discharge || discharge.admission.encounter.facilityId !== input.facilityId) throw new NotFoundError("Discharge not found.");
    if (discharge.dischargedAt) throw new BadRequestError("The patient has already been discharged.");
    if ((await activeHoldReasons(tx, input.dischargeId)).includes(input.reasonCode)) throw new ConflictError(`A ${input.reasonCode} hold is already active on this discharge.`);
    const hold = await tx.dischargeHold.create({ data: { dischargeId: input.dischargeId, facilityId: input.facilityId, reasonCode: input.reasonCode, placedByUserId: input.byUserId } });
    return { hold, enc: await emitHold(tx, hold, "PLACED", input.byUserId) };
  });
  await recordAuditEvent("hospital.discharge.holdPlaced", input.byUserId, { dischargeId: input.dischargeId, holdId: hold.id, reasonCode: hold.reasonCode },
    { facilityId: enc.facilityId, patientId: enc.patientId, encounterId: enc.id });
  return hold;
}

export async function clearDischargeHold(input: { holdId: string; facilityId: string; byUserId: string }) {
  const { hold, enc } = await prisma.$transaction(async (tx) => {
    const current = await tx.dischargeHold.findUnique({ where: { id: input.holdId } });
    if (!current || current.facilityId !== input.facilityId) throw new NotFoundError("Hold not found.");
    const r = await tx.dischargeHold.updateMany({ where: { id: current.id, clearedAt: null }, data: { clearedAt: new Date(), clearedByUserId: input.byUserId } });
    if (r.count !== 1) throw new ConflictError("This hold has already been cleared.");
    const hold = await tx.dischargeHold.findUniqueOrThrow({ where: { id: current.id } });
    return { hold, enc: await emitHold(tx, hold, "CLEARED", input.byUserId) };
  });
  await recordAuditEvent("hospital.discharge.holdCleared", input.byUserId, { dischargeId: hold.dischargeId, holdId: hold.id, reasonCode: hold.reasonCode },
    { facilityId: enc.facilityId, patientId: enc.patientId, encounterId: enc.id });
  return hold;
}

export async function listDischargeHolds(dischargeId: string) {
  return prisma.dischargeHold.findMany({ where: { dischargeId }, orderBy: { placedAt: "asc" } });
}
