import { prisma } from "@/lib/db";
import { EncounterStatus } from "@prisma/client";
import { recordAuditEvent } from "@/lib/auth/audit";

/**
 * Controlled encounter lifecycle (brief §13). Uses the existing
 * EncounterStatus enum values (REGISTERED/TRIAGED/IN_CONSULTATION/
 * INVESTIGATING/ADMITTED/DISCHARGED/CLOSED/CANCELLED) rather than
 * introducing the brief's differently-named state set (CHECKED_IN/WAITING/
 * ON_HOLD/ORDERS_PENDING/TREATMENT/DISPOSITION_PENDING/COMPLETED) — the
 * existing states already cover the same clinical meaning and are the
 * ones every existing Hospital OS route, seed row, and UI component
 * already reads/writes. Renaming them would be a purely cosmetic, large-
 * blast-radius change to already-working, tested code — see
 * docs/CLINICAL_CORE.md §3 for the full reasoning. What was missing was
 * the *control* (illegal transitions silently allowed before this file
 * existed), not the state names.
 */
const ALLOWED_TRANSITIONS: Record<EncounterStatus, EncounterStatus[]> = {
  REGISTERED: [EncounterStatus.TRIAGED, EncounterStatus.IN_CONSULTATION, EncounterStatus.ADMITTED, EncounterStatus.CANCELLED],
  TRIAGED: [EncounterStatus.IN_CONSULTATION, EncounterStatus.INVESTIGATING, EncounterStatus.ADMITTED, EncounterStatus.DISCHARGED, EncounterStatus.CANCELLED],
  IN_CONSULTATION: [EncounterStatus.INVESTIGATING, EncounterStatus.ADMITTED, EncounterStatus.DISCHARGED, EncounterStatus.CANCELLED],
  INVESTIGATING: [EncounterStatus.IN_CONSULTATION, EncounterStatus.ADMITTED, EncounterStatus.DISCHARGED, EncounterStatus.CANCELLED],
  ADMITTED: [EncounterStatus.DISCHARGED],
  DISCHARGED: [EncounterStatus.CLOSED],
  CANCELLED: [EncounterStatus.CLOSED],
  CLOSED: [],
};

// REGISTERED/TRIAGED -> ADMITTED covers direct/emergency admission paths where no separate
// IN_CONSULTATION/INVESTIGATING step happens first (e.g. a critical ED arrival admitted
// immediately) — matches how src/lib/hospital/admission.ts's admitPatient() has always
// behaved (it does not itself gate on prior status); this table now makes that legality
// explicit and enforced rather than implicit and unchecked.

export class InvalidEncounterTransitionError extends Error {
  constructor(from: EncounterStatus, to: EncounterStatus) {
    super(`Illegal encounter transition: ${from} -> ${to}`);
  }
}

export function isEncounterTransitionAllowed(from: EncounterStatus, to: EncounterStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** Validates + applies + audits a status change. Used by every route that moves an encounter forward. */
export async function transitionEncounter(
  encounterId: string,
  toStatus: EncounterStatus,
  opts: { byUserId: string; reason?: string; extraData?: Record<string, unknown> } = { byUserId: "system" }
) {
  const encounter = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } });
  if (encounter.status === toStatus) return encounter; // no-op, not an error — idempotent re-post is fine
  if (!isEncounterTransitionAllowed(encounter.status, toStatus)) {
    throw new InvalidEncounterTransitionError(encounter.status, toStatus);
  }

  const updated = await prisma.encounter.update({
    where: { id: encounterId },
    data: {
      status: toStatus,
      ...(toStatus === EncounterStatus.CANCELLED ? { cancelledReason: opts.reason, closedAt: new Date() } : {}),
      ...(toStatus === EncounterStatus.CLOSED && !encounter.closedAt ? { closedAt: new Date() } : {}),
      ...opts.extraData,
    },
  });

  await recordAuditEvent("hospital.encounter.updated", opts.byUserId, {
    encounterId,
    fromStatus: encounter.status,
    toStatus,
    reason: opts.reason,
  });

  return updated;
}
