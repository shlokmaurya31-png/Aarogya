import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { sendEmail } from "@/lib/email/send";
import { getStorageAdapter } from "@/lib/storage";
import { emitDomainEvent } from "@/lib/events/emit";
import { endShareTx } from "@/lib/sharing/shares";
import { declinePendingRequestsTx } from "@/lib/sharing/requests";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { requireOwnedPerson } from "./access";
import { withdrawAllergyBridges } from "@/lib/documents/merge";

/**
 * Phase 0, part 2 — account closure (docs/PERSON_IDENTITY_DESIGN.md §15 Q6).
 *
 *   close    the person's own login, with an explicit confirmation. From that
 *            moment nothing person-level is visible to anyone (the resolver
 *            only serves ACTIVE Persons): no uploads to hospitals, no portal.
 *   reopen   the same login, within the grace period: everything as before.
 *   purge    after CLOSURE_GRACE_DAYS (30), the runner deletes the person's
 *            patient-provided data: their documents (rows and stored bytes),
 *            contacts, identifiers, choices and access log; their links end
 *            (UNLINKED, ACCOUNT_CLOSED) and the login ends. Facility records
 *            are never touched — encounters, results, notes, bills, facility
 *            documents — and neither is anything a clinician confirmed into
 *            them (an upload a facility record references stays, detached
 *            from the Person, under records retention). A legal hold on any
 *            linked record defers the purge until the hold is lifted.
 */

export const CLOSURE_GRACE_DAYS = 30;
const DAY = 86_400_000;

async function closedOwnedPerson(userId: string) {
  const acct = await prisma.personAccount.findUnique({ where: { userId }, select: { personId: true, endedAt: true, person: { select: { status: true, purgeAfter: true, purgedAt: true } } } });
  if (!acct || acct.endedAt || acct.person.status !== "CLOSED" || acct.person.purgedAt) return null;
  return { personId: acct.personId, purgeAfter: acct.person.purgeAfter! };
}

async function tell(personId: string, subject: string, text: string) {
  const a = await prisma.personAccount.findFirst({ where: { personId, role: "OWNER" }, orderBy: { createdAt: "desc" }, select: { user: { select: { email: true } } } });
  if (a?.user.email) await sendEmail({ to: a.user.email, subject, text }).catch(() => undefined);
}

export async function closePersonAccount(userId: string, confirm: string) {
  if (confirm !== "CLOSE") throw new BadRequestError('Confirm by sending confirm: "CLOSE".');
  const personId = await requireOwnedPerson(userId);
  const now = new Date();
  const purgeAfter = new Date(now.getTime() + CLOSURE_GRACE_DAYS * DAY);
  await prisma.$transaction(async (tx) => {
    const r = await tx.person.updateMany({ where: { id: personId, status: "ACTIVE" }, data: { status: "CLOSED", closedAt: now, purgeAfter, version: { increment: 1 } } });
    if (r.count !== 1) throw new ConflictError("This account changed concurrently. Refresh and try again.");
    await tx.personAccessLogEntry.create({ data: { personId, kind: "ACCOUNT_CLOSED", actorUserId: userId, detail: { purgeAfter: purgeAfter.toISOString() } } });
    // Week 4c: closing ends every share the person gave and declines what is waiting; reopening doesn't bring them back.
    for (const s of await tx.recordShare.findMany({ where: { personId, status: { in: ["PENDING", "ACTIVE"] } }, select: { id: true } })) await endShareTx(tx, s.id, "REVOKED", "PERSON_CLOSED", userId);
    await declinePendingRequestsTx(tx, personId, userId);
    await emitDomainEvent(tx, { type: "PersonAccountClosed", aggregateId: personId, personId, actorUserId: userId, payload: { personId, purgeAfter: purgeAfter.toISOString() } });
  });
  await recordAuditEvent("person.account.closed", userId, { personId, purgeAfter: purgeAfter.toISOString() });
  await tell(personId, "Your Aarogya account is closed", `Your Aarogya account is closed. The documents and details you added will be deleted on ${purgeAfter.toISOString().slice(0, 10)}. Until then you can reopen it by signing in. Hospital records stay with the hospitals that made them.`);
  return { status: "CLOSED" as const, purgeAfter: purgeAfter.toISOString() };
}

export async function reopenPersonAccount(userId: string) {
  const closed = await closedOwnedPerson(userId);
  if (!closed) throw new NotFoundError();
  if (closed.purgeAfter.getTime() <= Date.now()) throw new ConflictError("The grace period has ended; this account can't be reopened.");
  await prisma.$transaction(async (tx) => {
    const r = await tx.person.updateMany({ where: { id: closed.personId, status: "CLOSED", purgedAt: null }, data: { status: "ACTIVE", closedAt: null, purgeAfter: null, version: { increment: 1 } } });
    if (r.count !== 1) throw new ConflictError("This account changed concurrently. Refresh and try again.");
    await tx.personAccessLogEntry.create({ data: { personId: closed.personId, kind: "ACCOUNT_REOPENED", actorUserId: userId } });
    await emitDomainEvent(tx, { type: "PersonAccountReopened", aggregateId: closed.personId, personId: closed.personId, actorUserId: userId, payload: { personId: closed.personId } });
  });
  await recordAuditEvent("person.account.reopened", userId, { personId: closed.personId });
  return { status: "ACTIVE" as const };
}

/** Is any record linked to this Person (in any link state) under a legal hold? */
async function underLegalHold(personId: string): Promise<boolean> {
  const patientIds = (await prisma.personPatientLink.findMany({ where: { personId }, select: { patientId: true } })).map((l) => l.patientId);
  if (!patientIds.length) return false;
  return (await prisma.privacyRequest.count({ where: { patientId: { in: patientIds }, legalHold: true } })) > 0;
}

/** Facility rows that reference an upload (it is then a facility record's, and stays). */
async function uploadReferenced(documentId: string): Promise<boolean> {
  const n = await Promise.all([
    prisma.complianceEvidence.count({ where: { documentId } }),
    prisma.credential.count({ where: { documentId } }),
    prisma.staffPrivilege.count({ where: { documentId } }),
    prisma.claimSubmissionDocument.count({ where: { documentId } }),
    prisma.claimQuery.count({ where: { responseDocumentIds: { contains: documentId } } }),
  ]);
  return n.some((x) => x > 0);
}

/**
 * The runner's sweep: purge every CLOSED Person whose grace period has ended
 * (see the file comment). Each Person in its own transaction; idempotent.
 */
export async function purgeClosedPersons(opts: { now?: Date; batchSize?: number } = {}) {
  const now = opts.now ?? new Date();
  const due = await prisma.person.findMany({ where: { status: "CLOSED", purgedAt: null, purgeAfter: { lte: now } }, select: { id: true }, take: opts.batchSize ?? 50, orderBy: { purgeAfter: "asc" } });
  const out = { purged: 0, deferredForLegalHold: 0, documentsDeleted: 0, documentsKept: 0 };
  const storage = getStorageAdapter();
  for (const { id: personId } of due) {
    if (await underLegalHold(personId)) {
      out.deferredForLegalHold += 1;
      await recordAuditEvent("person.account.purgeDeferred", null, { personId, reason: "LEGAL_HOLD" });
      continue;
    }
    const docs = await prisma.personDocument.findMany({ where: { personId }, select: { id: true, storageRef: true } });
    // The pipeline's derived objects (page copies, normalized images, PDF rasters) go with them.
    const pageObjects = (await prisma.documentPage.findMany({ where: { personId }, select: { storageRef: true, rasterRef: true } })).flatMap((p) => (p.rasterRef ? [p.storageRef, p.rasterRef] : [p.storageRef]));
    const legacy = await prisma.clinicalDocument.findMany({ where: { personId }, select: { id: true, storageRef: true } });
    const keepLegacy: string[] = [];
    for (const d of legacy) if (await uploadReferenced(d.id)) keepLegacy.push(d.id);
    const deleteLegacy = legacy.filter((d) => !keepLegacy.includes(d.id));
    const owner = await prisma.personAccount.findFirst({ where: { personId, role: "OWNER" }, orderBy: { createdAt: "desc" }, select: { userId: true } });
    await prisma.$transaction(async (tx) => {
      const live = await tx.personPatientLink.findMany({ where: { personId, status: { in: ["ACTIVE", "PENDING_VERIFICATION", "REVERIFICATION_REQUIRED"] } } });
      for (const l of live) {
        await tx.personPatientLink.update({ where: { id: l.id }, data: { status: "UNLINKED", unlinkedAt: now, unlinkedBy: "PERSON", unlinkedReason: "ACCOUNT_CLOSED", unlinkedByUserId: owner?.userId ?? "account-closed", version: { increment: 1 } } });
        await emitFacilityEvent(tx, {
          type: "PersonPatientUnlinked", aggregateId: l.id, facilityId: l.facilityId, personId,
          payload: { linkId: l.id, personId, patientId: l.patientId, by: "PERSON", reason: "ACCOUNT_CLOSED" },
        });
      }
      // Week 4a: the pipeline's derived data and the person's confirmed facts go
      // with their documents. Conflicts that a clinician resolved stay with the
      // facility record (they name only ids); open ones are withdrawn.
      await tx.recordConflict.deleteMany({ where: { personId, status: { not: "RESOLVED_BY_CLINICIAN" } } });
      // Bridged allergies no clinician confirmed are taken back (with the facility's notice) before their entries go.
      await withdrawAllergyBridges(tx, personId, {});
      await tx.patientProvidedRecord.deleteMany({ where: { personId } });
      await tx.documentProcessing.deleteMany({ where: { personId } });
      await tx.personDocument.deleteMany({ where: { personId } });
      await tx.clinicalDocument.deleteMany({ where: { id: { in: deleteLegacy.map((d) => d.id) } } });
      // Referenced uploads are now the facility record's: kept, detached from the Person.
      await tx.clinicalDocument.updateMany({ where: { id: { in: keepLegacy } }, data: { personId: null, legacyFacilityVisible: false } });
      await tx.personContact.deleteMany({ where: { personId } });
      await tx.personIdentifier.deleteMany({ where: { personId } });
      await tx.personConsent.deleteMany({ where: { personId } });
      // Week 4c: the person's shares and the requests about them.
      await tx.accessRequest.deleteMany({ where: { personId } });
      await tx.recordShare.deleteMany({ where: { personId } });
      await tx.personNotification.deleteMany({ where: { personId } });
      await tx.personAccessLogEntry.deleteMany({ where: { personId } });
      await tx.personAccount.updateMany({ where: { personId, endedAt: null }, data: { endedAt: now } });
      await tx.person.update({ where: { id: personId }, data: { purgedAt: now, displayName: "Closed account", dateOfBirth: null, dobPrecision: null, sex: null, version: { increment: 1 } } });
      await emitDomainEvent(tx, {
        type: "PersonDataPurged", aggregateId: personId, personId,
        payload: { personId, documentsDeleted: docs.length + deleteLegacy.length, documentsKept: keepLegacy.length, linksEnded: live.length },
      });
    });
    // Bytes go after the rows are gone (a failure leaves an orphan object, never a dangling row).
    for (const d of [...docs, ...deleteLegacy]) if (d.storageRef) await storage.delete(d.storageRef).catch(() => undefined);
    for (const ref of pageObjects) await storage.delete(ref).catch(() => undefined);
    await recordAuditEvent("person.account.purged", null, { personId, documentsDeleted: docs.length + deleteLegacy.length, documentsKept: keepLegacy.length });
    out.purged += 1;
    out.documentsDeleted += docs.length + deleteLegacy.length;
    out.documentsKept += keepLegacy.length;
  }
  return out;
}
