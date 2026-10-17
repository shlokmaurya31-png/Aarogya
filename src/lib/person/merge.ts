import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { verifyPassword } from "@/lib/auth/password";
import { sendEmail } from "@/lib/email/send";
import { emitDomainEvent } from "@/lib/events/emit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { ownedPersonId, requireOwnedPerson } from "./access";

type Tx = Prisma.TransactionClient;

/**
 * Phase 0 — merges and identity (docs/PERSON_IDENTITY_DESIGN.md §6).
 *
 * Facility record merges (patient/merge.ts) call carryLinksOnMerge /
 * restoreLinksOnUnmerge, in their transaction:
 *   source linked to P, target unlinked → the target gains P's link, the
 *                                          source's is SUPERSEDED;
 *   both linked to P                     → the source's is SUPERSEDED;
 *   linked to different Persons          → the merge is REFUSED;
 *   a verification in progress on either → REFUSED (finish or cancel it first);
 *   unmerge                              → links exactly as before the merge.
 *
 * Person merges: one human with two Persons. Only that human, signed in as
 * the surviving account, with the other account's password AND a code sent
 * to each account's email. Staff can never start or decide one. Every
 * person-owned row is re-pointed in one transaction, the other login ends,
 * the merged Person points at the survivor, and the snapshot makes it
 * reversible.
 */

export class PersonLinkConflictError extends ConflictError {
  constructor(message = "These records are connected to different people's accounts. Resolve that (unlink the wrong one) before merging.") {
    super(message);
  }
}

const LIVE = ["ACTIVE", "PENDING_VERIFICATION", "REVERIFICATION_REQUIRED"] as const;

export interface LinkSnapshot {
  sourceLinkId: string | null;
  sourcePriorStatus: string | null;
  carriedLinkId: string | null;
}

async function supersede(tx: Tx, link: { id: string; personId: string; patientId: string; facilityId: string }, replacedByLinkId: string | null, cause: "FACILITY_MERGE" | "FACILITY_UNMERGE", mergeRecordId: string, actorUserId: string) {
  await tx.personPatientLink.update({ where: { id: link.id }, data: { status: "SUPERSEDED", supersededByLinkId: replacedByLinkId, version: { increment: 1 } } });
  await tx.personAccessLogEntry.create({ data: { personId: link.personId, kind: "LINK_SUPERSEDED", accessingFacilityId: link.facilityId, actorUserId, detail: { linkId: link.id, cause } } });
  await emitFacilityEvent(tx, {
    type: "PersonPatientLinkSuperseded", aggregateId: link.id, facilityId: link.facilityId, personId: link.personId, actorUserId,
    payload: { linkId: link.id, personId: link.personId, patientId: link.patientId, ...(replacedByLinkId ? { replacedByLinkId } : {}), cause, mergeRecordId },
  });
}

/** In a facility merge's transaction: carry, supersede or refuse the Person links (table above). */
export async function carryLinksOnMerge(tx: Tx, input: { sourcePatientId: string; targetPatientId: string; mergeRecordId: string; actorUserId: string }): Promise<LinkSnapshot> {
  const [src, tgt] = await Promise.all([
    tx.personPatientLink.findFirst({ where: { patientId: input.sourcePatientId, status: { in: [...LIVE] } } }),
    tx.personPatientLink.findFirst({ where: { patientId: input.targetPatientId, status: { in: [...LIVE] } } }),
  ]);
  if (src?.status === "PENDING_VERIFICATION" || tgt?.status === "PENDING_VERIFICATION") {
    throw new PersonLinkConflictError("A connection to a person's account is being verified on one of these records. Finish or cancel it before merging.");
  }
  if (!src) return { sourceLinkId: null, sourcePriorStatus: null, carriedLinkId: null };
  if (tgt && tgt.personId !== src.personId) throw new PersonLinkConflictError();
  if (tgt) {
    await supersede(tx, src, tgt.id, "FACILITY_MERGE", input.mergeRecordId, input.actorUserId);
    return { sourceLinkId: src.id, sourcePriorStatus: src.status, carriedLinkId: null };
  }
  // The target gains the source's link: same Person, same verification.
  const carried = await tx.personPatientLink.create({
    data: {
      personId: src.personId, patientId: input.targetPatientId, facilityId: src.facilityId, status: src.status,
      method: src.method, linkRequestId: src.linkRequestId, linkedAt: src.linkedAt, linkedByUserId: src.linkedByUserId,
      idType: src.idType, idLast4: src.idLast4, verifiedByStaffId: src.verifiedByStaffId, approvedByStaffId: src.approvedByStaffId, inPersonReason: src.inPersonReason,
    },
  });
  await supersede(tx, src, carried.id, "FACILITY_MERGE", input.mergeRecordId, input.actorUserId);
  return { sourceLinkId: src.id, sourcePriorStatus: src.status, carriedLinkId: carried.id };
}

/** In an unmerge's transaction: put the links back exactly as the snapshot recorded them. */
export async function restoreLinksOnUnmerge(tx: Tx, input: { snapshot: LinkSnapshot | null; mergeRecordId: string; actorUserId: string }) {
  const snap = input.snapshot;
  if (!snap?.sourceLinkId) return;
  const source = await tx.personPatientLink.findUniqueOrThrow({ where: { id: snap.sourceLinkId } });
  if (snap.carriedLinkId) {
    const carried = await tx.personPatientLink.findUniqueOrThrow({ where: { id: snap.carriedLinkId } });
    if (LIVE.includes(carried.status as (typeof LIVE)[number])) await supersede(tx, carried, source.id, "FACILITY_UNMERGE", input.mergeRecordId, input.actorUserId);
  }
  if (source.status === "SUPERSEDED" && snap.sourcePriorStatus) {
    await tx.personPatientLink.update({ where: { id: source.id }, data: { status: snap.sourcePriorStatus as "ACTIVE" | "REVERIFICATION_REQUIRED", supersededByLinkId: null, version: { increment: 1 } } });
    await tx.personAccessLogEntry.create({ data: { personId: source.personId, kind: "LINKED", accessingFacilityId: source.facilityId, actorUserId: input.actorUserId, detail: { linkId: source.id, cause: "FACILITY_UNMERGE" } } });
  }
}

// ── Person merges ───────────────────────────────────────────────────────────

const CODE_TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

function hash(requestId: string, which: "T" | "S", code: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not configured.");
  return createHmac("sha256", secret).update(`${requestId}:${which}:${code}`).digest("hex");
}
const same = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/**
 * Step 1, signed in as the account that survives: the other account's email
 * and password. Then a code goes to each account's email. A wrong password
 * says nothing about the other account.
 */
export async function startPersonMerge(userId: string, input: { otherEmail: string; otherPassword: string }) {
  const personId = await requireOwnedPerson(userId);
  const other = await prisma.user.findUnique({ where: { email: (input.otherEmail ?? "").trim().toLowerCase() }, select: { id: true, email: true, passwordHash: true, role: true } });
  const ok = other && other.role === "PATIENT" && other.id !== userId && (await verifyPassword(String(input.otherPassword ?? ""), other.passwordHash));
  const sourcePersonId = ok ? await ownedPersonId(other!.id) : null;
  if (!ok || !sourcePersonId || sourcePersonId === personId) {
    await recordAuditEvent("person.merge.refused", userId, { personId, reason: "OTHER_ACCOUNT_NOT_VERIFIED" });
    throw new BadRequestError("We couldn't verify the other account.");
  }
  const me = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  const t = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const s = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.personMergeRequest.updateMany({ where: { personId, status: "PENDING" }, data: { status: "EXPIRED" } });
  const req = await prisma.personMergeRequest.create({
    data: { personId, sourcePersonId, initiatedByUserId: userId, targetCodeHash: "pending", sourceCodeHash: "pending", expiresAt: new Date(Date.now() + CODE_TTL_MS) },
  });
  await prisma.personMergeRequest.update({ where: { id: req.id }, data: { targetCodeHash: hash(req.id, "T", t), sourceCodeHash: hash(req.id, "S", s) } });
  const text = (code: string) => `Your Aarogya code to combine two accounts is ${code}. It expires in 15 minutes. If you didn't ask to combine accounts, ignore this and change your password.`;
  const [a, b] = await Promise.all([
    sendEmail({ to: me.email, subject: "Combine your Aarogya accounts", text: text(t) }),
    sendEmail({ to: other!.email, subject: "Combine your Aarogya accounts", text: text(s) }),
  ]);
  if (!a.delivered || !b.delivered) {
    await prisma.personMergeRequest.update({ where: { id: req.id }, data: { status: "FAILED" } });
    throw new BadRequestError("We couldn't send the verification codes. Try again later.");
  }
  await recordAuditEvent("person.merge.requested", userId, { personId, sourcePersonId, requestId: req.id });
  return { requestId: req.id, expiresAt: req.expiresAt.toISOString() };
}

/** Step 2: both codes. Correct → the merge, in one transaction. */
export async function confirmPersonMerge(userId: string, requestId: string, codes: { thisAccountCode: string; otherAccountCode: string }) {
  const personId = await requireOwnedPerson(userId);
  const req = await prisma.personMergeRequest.findUnique({ where: { id: requestId } });
  if (!req || req.personId !== personId || req.initiatedByUserId !== userId) throw new NotFoundError();
  if (req.status !== "PENDING") throw new ConflictError("This request is no longer open.");
  if (req.expiresAt.getTime() < Date.now()) {
    await prisma.personMergeRequest.update({ where: { id: req.id }, data: { status: "EXPIRED" } });
    throw new BadRequestError("The codes have expired. Start again.");
  }
  const good = same(req.targetCodeHash, hash(req.id, "T", String(codes.thisAccountCode ?? "").trim()))
    && same(req.sourceCodeHash, hash(req.id, "S", String(codes.otherAccountCode ?? "").trim()));
  if (!good) {
    const attempts = req.attempts + 1;
    await prisma.personMergeRequest.update({ where: { id: req.id }, data: { attempts, ...(attempts >= MAX_ATTEMPTS ? { status: "FAILED" } : {}) } });
    return { status: "INVALID" as const, attemptsLeft: Math.max(MAX_ATTEMPTS - attempts, 0) };
  }
  const record = await prisma.$transaction((tx) => mergePersonsTx(tx, req, userId));
  await recordAuditEvent("person.merge.completed", userId, { personId, sourcePersonId: req.sourcePersonId, mergeRecordId: record.id });
  return { status: "MERGED" as const, personId, mergeRecordId: record.id };
}

async function mergePersonsTx(tx: Tx, req: { id: string; personId: string; sourcePersonId: string }, userId: string) {
  const cas = await tx.personMergeRequest.updateMany({ where: { id: req.id, status: "PENDING" }, data: { status: "COMPLETED", completedAt: new Date() } });
  if (cas.count !== 1) throw new ConflictError("This request is no longer open.");
  const from = req.sourcePersonId;
  const to = req.personId;
  const ids = async (rows: Promise<{ id: string }[]>) => (await rows).map((r) => r.id);
  const snapshot = {
    links: await ids(tx.personPatientLink.findMany({ where: { personId: from }, select: { id: true } })),
    linkRequests: await ids(tx.patientLinkRequest.findMany({ where: { personId: from }, select: { id: true } })),
    contacts: await ids(tx.personContact.findMany({ where: { personId: from }, select: { id: true } })),
    identifiers: await ids(tx.personIdentifier.findMany({ where: { personId: from }, select: { id: true } })),
    accessLog: await ids(tx.personAccessLogEntry.findMany({ where: { personId: from }, select: { id: true } })),
    uploads: await ids(tx.clinicalDocument.findMany({ where: { personId: from }, select: { id: true } })),
    consents: [] as { id: string; action: "REPOINTED" | "SUPERSEDED" }[],
    endedAccounts: await ids(tx.personAccount.findMany({ where: { personId: from, endedAt: null }, select: { id: true } })),
  };
  await tx.personPatientLink.updateMany({ where: { personId: from }, data: { personId: to } });
  await tx.patientLinkRequest.updateMany({ where: { personId: from }, data: { personId: to } });
  await tx.personContact.updateMany({ where: { personId: from }, data: { personId: to } });
  await tx.personIdentifier.updateMany({ where: { personId: from }, data: { personId: to } });
  await tx.personAccessLogEntry.updateMany({ where: { personId: from }, data: { personId: to } });
  await tx.clinicalDocument.updateMany({ where: { personId: from }, data: { personId: to } });
  // Choices: the same choice carries; two different choices both lapse, so the
  // person is asked again (never silently pick one).
  const now = new Date();
  for (const c of await tx.personConsent.findMany({ where: { personId: from, status: "ACTIVE" } })) {
    const mine = await tx.personConsent.findFirst({ where: { personId: to, purpose: c.purpose, status: "ACTIVE" } });
    if (!mine) {
      await tx.personConsent.update({ where: { id: c.id }, data: { personId: to } });
      snapshot.consents.push({ id: c.id, action: "REPOINTED" });
    } else {
      await tx.personConsent.update({ where: { id: c.id }, data: { status: "SUPERSEDED", supersededAt: now } });
      snapshot.consents.push({ id: c.id, action: "SUPERSEDED" });
      if (mine.decision !== c.decision) {
        await tx.personConsent.update({ where: { id: mine.id }, data: { status: "SUPERSEDED", supersededAt: now } });
        snapshot.consents.push({ id: mine.id, action: "SUPERSEDED" });
      }
    }
  }
  await tx.personConsent.updateMany({ where: { personId: from }, data: { personId: to } });
  await tx.personAccount.updateMany({ where: { personId: from, endedAt: null }, data: { endedAt: now } });
  await tx.person.update({ where: { id: from }, data: { status: "MERGED", mergedIntoPersonId: to, mergedAt: now, version: { increment: 1 } } });
  const record = await tx.personMergeRecord.create({ data: { personId: to, sourcePersonId: from, method: "BOTH_ACCOUNTS_PROVEN", requestId: req.id, actorUserId: userId, snapshot } });
  await tx.personAccessLogEntry.create({ data: { personId: to, kind: "PERSON_MERGED", actorUserId: userId, detail: { mergeRecordId: record.id, sourcePersonId: from } } });
  await emitDomainEvent(tx, {
    type: "PersonMerged", aggregateId: to, personId: to, actorUserId: userId,
    payload: { personId: to, sourcePersonId: from, mergeRecordId: record.id, method: "BOTH_ACCOUNTS_PROVEN" },
  });
  return record;
}
