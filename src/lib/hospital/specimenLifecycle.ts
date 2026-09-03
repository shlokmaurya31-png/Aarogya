import { Prisma, SpecimenStatus, SpecimenRejectionReason } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { generateAccessionNumber as generateAccessionNumberWithPrefix } from "./accessionNumber";

type Tx = Prisma.TransactionClient;

/**
 * Specimen state machine (brief §12-15). One specimen per LabOrder this
 * milestone (user-confirmed scope) — the FK isn't unique so the schema
 * doesn't block a future multi-specimen panel workflow. ORDERED and LOST
 * are declared on the enum (matching the brief's full vocabulary) but have
 * no route reaching them yet this milestone, same "declared, not invented"
 * discipline as Milestone A left LabOrder's CANCELLED transition.
 */
const SPECIMEN_ALLOWED: Record<SpecimenStatus, SpecimenStatus[]> = {
  ORDERED: ["COLLECTION_PENDING"],
  COLLECTION_PENDING: ["COLLECTED", "CANCELLED"],
  COLLECTED: ["RECEIVED"],
  RECEIVED: ["ACCEPTED", "REJECTED"],
  // Result entry (src/lib/hospital/labResultLifecycle.ts) moves an accepted
  // specimen straight to RESULTED — IN_PROCESS is declared on the enum
  // (matching the brief's vocabulary) but has no distinct persisted state
  // or route this milestone, same discipline as ORDERED/LOST above.
  ACCEPTED: ["RESULTED"],
  IN_PROCESS: [],
  RESULTED: ["ARCHIVED"],
  ARCHIVED: [],
  // REJECTED is terminal for THIS specimen row (brief §15 — "the original
  // specimen is never erased"). "Needs recollection" is derived by the
  // worklist query (a REJECTED specimen with no Specimen row pointing back
  // at it via recollectionOfSpecimenId yet), not a further status mutation
  // on the rejected row itself — RECOLLECTION_REQUIRED stays declared on
  // the enum (matching the brief's vocabulary) but unused as a persisted
  // status this milestone, same "declared, not invented" discipline as
  // Milestone A left LabOrder's CANCELLED transition.
  REJECTED: [],
  LOST: [],
  CANCELLED: [],
  RECOLLECTION_REQUIRED: [],
};

export class InvalidSpecimenTransitionError extends BadRequestError {
  constructor(from: SpecimenStatus, to: SpecimenStatus) {
    super(`Illegal specimen transition: ${from} -> ${to}`);
  }
}

/** Thrown when a guarded concurrent update affects zero rows — someone else won the race. */
export class SpecimenConcurrencyError extends BadRequestError {
  constructor(action: string) {
    super(`Specimen was already ${action} by someone else, or is no longer in the expected state. Refresh and try again.`);
  }
}

export function isSpecimenTransitionAllowed(from: SpecimenStatus, to: SpecimenStatus): boolean {
  return SPECIMEN_ALLOWED[from]?.includes(to) ?? false;
}

/** Lab-prefixed accession number — see src/lib/hospital/accessionNumber.ts for the shared generator this wraps. */
export function generateAccessionNumber(): string {
  return generateAccessionNumberWithPrefix("LAB");
}

/** Creates the Specimen row at order-placement time, already queued for collection. Called inside the order's own transaction. */
export async function accessionSpecimen(
  tx: Tx,
  input: { labOrderId: string; facilityId: string; patientId: string; encounterId: string; specimenType: string }
) {
  return tx.specimen.create({
    data: {
      labOrderId: input.labOrderId,
      facilityId: input.facilityId,
      patientId: input.patientId,
      encounterId: input.encounterId,
      specimenType: input.specimenType,
      accessionNumber: generateAccessionNumber(),
      status: "COLLECTION_PENDING",
    },
  });
}

async function guardedTransition(
  tx: Tx,
  specimenId: string,
  from: SpecimenStatus,
  to: SpecimenStatus,
  data: Record<string, unknown>,
  actionLabel: string
) {
  const result = await tx.specimen.updateMany({ where: { id: specimenId, status: from }, data: { status: to, ...data } });
  if (result.count !== 1) throw new SpecimenConcurrencyError(actionLabel);
  return tx.specimen.findUniqueOrThrow({ where: { id: specimenId } });
}

export async function collectSpecimen(tx: Tx, specimenId: string, collectedByStaffId: string, notes?: string) {
  const specimen = await guardedTransition(tx, specimenId, "COLLECTION_PENDING", "COLLECTED", { collectedByStaffId, collectedAt: new Date(), collectionNotes: notes }, "collected");
  await tx.labOrder.updateMany({ where: { id: specimen.labOrderId, status: "ORDERED" }, data: { status: "COLLECTED" } });
  return specimen;
}

export async function receiveSpecimen(tx: Tx, specimenId: string, receivedByStaffId: string) {
  return guardedTransition(tx, specimenId, "COLLECTED", "RECEIVED", { receivedByStaffId, receivedAt: new Date() }, "received");
}

export async function acceptSpecimen(tx: Tx, specimenId: string, acceptedByStaffId: string) {
  const specimen = await guardedTransition(tx, specimenId, "RECEIVED", "ACCEPTED", { acceptedByStaffId, acceptedAt: new Date() }, "accepted");
  await tx.labOrder.updateMany({ where: { id: specimen.labOrderId, status: "COLLECTED" }, data: { status: "IN_PROGRESS" } });
  return specimen;
}

export async function rejectSpecimen(
  tx: Tx,
  specimenId: string,
  reason: SpecimenRejectionReason,
  rejectedByStaffId: string,
  notes?: string
) {
  const specimen = await tx.specimen.findUniqueOrThrow({ where: { id: specimenId } });
  if (!isSpecimenTransitionAllowed(specimen.status, "REJECTED")) {
    throw new InvalidSpecimenTransitionError(specimen.status, "REJECTED");
  }
  const result = await tx.specimen.updateMany({
    where: { id: specimenId, status: specimen.status },
    data: { status: "REJECTED", rejectedReason: reason, rejectedNotes: notes, rejectedByStaffId, rejectedAt: new Date() },
  });
  if (result.count !== 1) throw new SpecimenConcurrencyError("rejected");
  return tx.specimen.findUniqueOrThrow({ where: { id: specimenId } });
}

/** Creates a NEW specimen row for the same order, linked back to the rejected original — full history preserved (brief §15). */
export async function recollectSpecimen(tx: Tx, rejectedSpecimenId: string, specimenType?: string) {
  const original = await tx.specimen.findUniqueOrThrow({ where: { id: rejectedSpecimenId }, include: { recollections: true } });
  if (original.status !== "REJECTED") {
    throw new InvalidSpecimenTransitionError(original.status, "COLLECTION_PENDING");
  }
  if (original.recollections.length > 0) {
    throw new BadRequestError("This specimen has already been recollected.");
  }
  return tx.specimen.create({
    data: {
      labOrderId: original.labOrderId,
      facilityId: original.facilityId,
      patientId: original.patientId,
      encounterId: original.encounterId,
      specimenType: specimenType ?? original.specimenType,
      accessionNumber: generateAccessionNumber(),
      status: "COLLECTION_PENDING",
      recollectionOfSpecimenId: original.id,
    },
  });
}

/** Facility-scoped fetch, used by every specimen-action route before transitioning. */
export async function findSpecimenInFacility(specimenId: string, facilityId: string) {
  const specimen = await prisma.specimen.findUnique({ where: { id: specimenId } });
  if (!specimen || specimen.facilityId !== facilityId) throw new NotFoundError("Specimen not found.");
  return specimen;
}
