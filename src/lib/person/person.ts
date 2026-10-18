import type { Prisma, PersonLinkMethod } from "@prisma/client";
import { ConflictError } from "@/lib/auth/rbac";
import { emitDomainEvent } from "@/lib/events/emit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

type Tx = Prisma.TransactionClient;

/**
 * Phase 0 — the platform-level Person (docs/PERSON_IDENTITY_DESIGN.md).
 *
 * A Person belongs to no facility. It is created for an account at sign-up
 * (the account is its OWNER login), and facility Patient records join it only
 * through a verified PersonPatientLink. Person demographics are the person's
 * own view and are never copied into, or from, facility records.
 */

export { PERSON_SOURCES, type PersonSource } from "./vocab";
import type { PersonSource } from "./vocab";

/** Normalized email for a contact row (case-insensitive by convention). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Creates the Person an account owns, in the caller's transaction: the
 * Person, its OWNER account row, and the sign-up email as an unverified
 * contact. Emits PersonCreated (PERSON scope) and writes the person's access
 * log. Refuses if the account already owns a Person.
 */
export async function createPersonForAccount(tx: Tx, input: {
  userId: string;
  displayName: string;
  email?: string | null;
  dateOfBirth?: Date | null;
  sex?: string | null;
  source: PersonSource;
}) {
  const existing = await tx.personAccount.findUnique({ where: { userId: input.userId } });
  if (existing) throw new ConflictError("This account already has a person record.");
  const person = await tx.person.create({
    data: {
      displayName: input.displayName.trim().slice(0, 200),
      dateOfBirth: input.dateOfBirth ?? undefined,
      sex: input.sex ?? undefined,
      accounts: { create: { userId: input.userId, role: "OWNER" } },
      ...(input.email ? { contacts: { create: { kind: "EMAIL" as const, value: normalizeEmail(input.email) } } } : {}),
    },
  });
  await tx.personAccessLogEntry.create({ data: { personId: person.id, kind: "PERSON_CREATED", actorUserId: input.userId, detail: { source: input.source } } });
  await emitDomainEvent(tx, {
    type: "PersonCreated", aggregateId: person.id, personId: person.id, actorUserId: input.userId,
    payload: { personId: person.id, source: input.source },
  });
  return person;
}

/**
 * Records an ACTIVE link from a facility record to a Person, in the caller's
 * transaction, with the access-log entry and PersonPatientLinked (FACILITY
 * scope, carrying the personId). The partial unique index refuses a second
 * live link to the same record; the trigger refuses a facility mismatch.
 * Callers are the verified paths only (self-created at registration here;
 * the code, ABHA and in-person paths in linking.ts).
 */
export async function recordActiveLink(tx: Tx, input: {
  personId: string;
  patientId: string;
  facilityId: string;
  method: PersonLinkMethod;
  linkedByUserId: string;
  linkRequestId?: string | null;
  inPerson?: { idType: Prisma.PersonPatientLinkCreateInput["idType"]; idLast4: string; reason: Prisma.PersonPatientLinkCreateInput["inPersonReason"]; verifiedByStaffId: string; approvedByStaffId: string };
}) {
  const fields = {
    method: input.method, linkRequestId: input.linkRequestId ?? undefined, linkedAt: new Date(), linkedByUserId: input.linkedByUserId,
    ...(input.inPerson ? {
      idType: input.inPerson.idType, idLast4: input.inPerson.idLast4, inPersonReason: input.inPerson.reason,
      verifiedByStaffId: input.inPerson.verifiedByStaffId, approvedByStaffId: input.inPerson.approvedByStaffId,
    } : {}),
  };
  // A link the identity migration couldn't trust (REVERIFICATION_REQUIRED)
  // becomes ACTIVE in place once this person verifies it.
  const pending = await tx.personPatientLink.findFirst({ where: { personId: input.personId, patientId: input.patientId, status: "REVERIFICATION_REQUIRED" } });
  const link = pending
    ? await tx.personPatientLink.update({ where: { id: pending.id }, data: { ...fields, status: "ACTIVE", version: { increment: 1 } } })
    : await tx.personPatientLink.create({ data: { personId: input.personId, patientId: input.patientId, facilityId: input.facilityId, status: "ACTIVE", ...fields } });
  await tx.personAccessLogEntry.create({
    data: { personId: input.personId, kind: "LINKED", accessingFacilityId: input.facilityId, actorUserId: input.linkedByUserId, detail: { linkId: link.id, method: input.method } },
  });
  await emitFacilityEvent(tx, {
    type: "PersonPatientLinked", aggregateId: link.id, facilityId: input.facilityId, personId: input.personId, actorUserId: input.linkedByUserId,
    payload: { linkId: link.id, personId: input.personId, patientId: input.patientId, method: input.method },
  });
  return link;
}

/** The Person an account owns (OWNER, not ended), or null. */
export async function personForUser(db: Pick<Tx, "personAccount">, userId: string) {
  const acct = await db.personAccount.findUnique({ where: { userId }, select: { personId: true, endedAt: true, person: { select: { status: true } } } });
  if (!acct || acct.endedAt || acct.person.status !== "ACTIVE") return null;
  return acct.personId;
}
