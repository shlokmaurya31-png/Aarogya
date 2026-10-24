import type { ClaimDocumentRequest, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import type { DomainEventConsumer } from "@/lib/events/consumers";
import { queuePersonNotificationTx } from "@/lib/person/notifications";
import { resolvePatientIdsForRead } from "@/lib/patient/merge";
import { sensitiveAllowed } from "@/lib/sharing/history";
import { SENSITIVE_CATEGORIES } from "@/lib/sharing/categories";
import { activeLinkedPatients, createShareTx, endShareTx } from "@/lib/sharing/shares";
import { insurancePerson, personPatientIds } from "./status";

/**
 * Week 5c — documents for a claim (docs/PATIENT_INSURANCE_DESIGN.md §5, §14).
 * Patients never answer an insurer's query themselves: the hospital does. When
 * the hospital needs a document, its billing staff ask (a short plain-words
 * description; the patient is told); the patient, or their INSURANCE proxy,
 * attaches some of their uploads. That makes a CLAIM share for the facility of
 * exactly those uploads (never ID proofs; a sensitive one only when the patient
 * confirms it), readable by the facility's billing staff one document at a
 * time, never as a record view and never by the AI, until the claim is
 * settled or closed. Every change emits ClaimDocumentRequestChanged.
 */
type Tx = Prisma.TransactionClient;
const CLAIM_SHARE_DAYS = 180;
const OPEN_CLAIM = ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "PARTIALLY_APPROVED", "REJECTED"];

async function changedTx(tx: Tx, r: ClaimDocumentRequest, from: "NONE" | "OPEN", to: "OPEN" | "FULFILLED" | "CANCELLED", actorUserId: string | null, shareId?: string) {
  await emitFacilityEvent(tx, {
    type: "ClaimDocumentRequestChanged", aggregateId: r.id, facilityId: r.facilityId, actorUserId,
    payload: { requestId: r.id, claimId: r.claimId, patientId: r.patientId, from, to, ...(shareId ? { shareId } : {}) },
  });
}

/** The Person a facility record belongs to now (an ACTIVE link), if any. */
async function personOf(patientId: string): Promise<string | null> {
  return (await prisma.personPatientLink.findFirst({ where: { patientId: { in: await resolvePatientIdsForRead(patientId) }, status: "ACTIVE" }, select: { personId: true } }))?.personId ?? null;
}

/** Billing staff ask the patient for documents for one of their facility's claims. */
export async function requestClaimDocuments(staff: { userId: string; facilityId: string }, claimId: string, description: unknown) {
  const text = typeof description === "string" ? description.trim().slice(0, 500) : "";
  if (text.length < 5) throw new BadRequestError("Say what document is needed, in plain words.");
  const claim = await prisma.claim.findUnique({ where: { id: claimId }, include: { invoice: { select: { patientId: true } } } });
  if (!claim || claim.facilityId !== staff.facilityId) throw new NotFoundError();
  if (!OPEN_CLAIM.includes(claim.status)) throw new ConflictError("This claim is closed.");
  const personId = await personOf(claim.invoice.patientId);
  const r = await prisma.$transaction(async (tx) => {
    const created = await tx.claimDocumentRequest.create({ data: { facilityId: staff.facilityId, claimId, patientId: claim.invoice.patientId, description: text, requestedByUserId: staff.userId } });
    await changedTx(tx, created, "NONE", "OPEN", staff.userId);
    if (personId) await notifyPersonAndProxiesTx(tx, personId, "DOCUMENTS_REQUESTED", `DOCUMENTS_REQUESTED:${created.id}`);
    return created;
  });
  await recordAuditEvent("hospital.claimDocuments.requested", staff.userId, { requestId: r.id, claimId }, { facilityId: staff.facilityId, patientId: r.patientId });
  return { id: r.id, status: r.status, patientLinked: !!personId };
}

/** The person (or an INSURANCE proxy) attaches uploads: a CLAIM share of exactly them. */
export async function attachClaimDocuments(a: { userId: string; memberPersonId?: string }, requestId: string, body: { documentIds?: unknown; confirmSensitive?: unknown }) {
  const personId = await insurancePerson(a);
  const r = await prisma.claimDocumentRequest.findUnique({ where: { id: requestId } });
  if (!r || !(await personPatientIds(personId)).includes(r.patientId)) throw new NotFoundError();
  if (r.status !== "OPEN") throw new ConflictError("This request is no longer open.");
  const ids = Array.isArray(body.documentIds) ? [...new Set(body.documentIds.map(String))] : [];
  if (!ids.length || ids.length > 10) throw new BadRequestError("Choose 1 to 10 of your documents.");
  const docs = await prisma.personDocument.findMany({ where: { id: { in: ids }, personId, status: "CURRENT" } });
  if (docs.length !== ids.length) throw new NotFoundError();
  if (docs.some((d) => d.type === "ID_PROOF")) throw new BadRequestError("ID proofs aren't shared this way: show them at the hospital's desk.");
  const sensitive = docs.some((d) => !sensitiveAllowed([], { texts: [d.title] }));
  if (sensitive && body.confirmSensitive !== true) throw new ConflictError("One of these documents may be sensitive (for example HIV or mental health). Confirm you want to share it.");
  const out = await prisma.$transaction(async (tx) => {
    const cur = await tx.claimDocumentRequest.findUniqueOrThrow({ where: { id: r.id } });
    if (cur.status !== "OPEN") throw new ConflictError("This request is no longer open.");
    const share = await createShareTx(tx, {
      personId, kind: "CLAIM", status: "ACTIVE", patientIds: await activeLinkedPatients(personId, tx), createdByUserId: a.userId, recipientFacilityId: r.facilityId,
      choice: { purpose: "OTHER", categories: ["UPLOADS"], sensitiveCategories: sensitive ? [...SENSITIVE_CATEGORIES] : [] },
      expiresAt: new Date(Date.now() + CLAIM_SHARE_DAYS * 86_400_000), documentIds: ids,
    });
    const u = await tx.claimDocumentRequest.updateMany({ where: { id: r.id, status: "OPEN" }, data: { status: "FULFILLED", shareId: share.id, fulfilledByUserId: a.userId, fulfilledAt: new Date(), version: { increment: 1 } } });
    if (u.count !== 1) throw new ConflictError("This request is no longer open.");
    await changedTx(tx, r, "OPEN", "FULFILLED", a.userId, share.id);
    if (a.memberPersonId) await tx.personAccessLogEntry.create({ data: { personId, kind: "PROXY_ACTION", actorUserId: a.userId, detail: { via: "PROXY", action: "CLAIM_DOCUMENTS", requestId: r.id, documents: ids.length } } });
    return share;
  });
  await recordAuditEvent("patient.claimDocuments.attached", a.userId, { requestId: r.id, shareId: out.id, documents: ids.length }, { facilityId: r.facilityId, patientId: r.patientId });
  return { status: "FULFILLED" as const, shareId: out.id };
}

/** Billing staff: the facility's requests for a claim, and the documents attached (download each through the CLAIM share). */
export async function claimDocumentRequests(staff: { facilityId: string }, claimId: string) {
  const rows = await prisma.claimDocumentRequest.findMany({ where: { claimId, facilityId: staff.facilityId }, orderBy: { createdAt: "desc" } });
  const shares = await prisma.recordShare.findMany({ where: { id: { in: rows.map((r) => r.shareId).filter((x): x is string => !!x) } }, select: { id: true, status: true, documentIds: true } });
  const docs = await prisma.personDocument.findMany({ where: { id: { in: shares.flatMap((s) => (s.status === "ACTIVE" ? s.documentIds : [])) }, status: "CURRENT" }, select: { id: true, title: true } });
  return {
    requests: rows.map((r) => {
      const s = shares.find((x) => x.id === r.shareId);
      return { id: r.id, description: r.description, status: r.status, createdAt: r.createdAt.toISOString(), shareId: s?.status === "ACTIVE" ? s.id : null, documents: s?.status === "ACTIVE" ? docs.filter((d) => s.documentIds.includes(d.id)) : [] };
    }),
  };
}

export async function cancelClaimDocumentRequest(staff: { userId: string; facilityId: string }, requestId: string) {
  const r = await prisma.claimDocumentRequest.findUnique({ where: { id: requestId } });
  if (!r || r.facilityId !== staff.facilityId) throw new NotFoundError();
  await prisma.$transaction(async (tx) => {
    const u = await tx.claimDocumentRequest.updateMany({ where: { id: r.id, status: "OPEN" }, data: { status: "CANCELLED", version: { increment: 1 } } });
    if (u.count !== 1) throw new ConflictError("This request is no longer open.");
    await changedTx(tx, r, "OPEN", "CANCELLED", staff.userId);
  });
  return { status: "CANCELLED" as const };
}

/** The person, and every member-side proxy who holds INSURANCE for them, is told (no amounts or detail in the text). */
export async function notifyPersonAndProxiesTx(tx: Tx, personId: string, kind: "INSURANCE_UPDATE" | "DOCUMENTS_REQUESTED" | "BILL_READY" | "CHECKIN_OPEN", dedupeKey: string, permission: "INSURANCE" | "BOOK" = "INSURANCE") {
  await queuePersonNotificationTx(tx, { personId, kind, dedupeKey: `${dedupeKey}:${personId}` });
  const proxies = await tx.proxyGrant.findMany({ where: { memberPersonId: personId, status: "ACTIVE", permissions: { has: permission }, OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }] }, select: { proxyPersonId: true } });
  for (const p of proxies) await queuePersonNotificationTx(tx, { personId: p.proxyPersonId, kind, dedupeKey: `${dedupeKey}:${p.proxyPersonId}` });
}

/**
 * claim-documents-lifecycle: a claim settled or closed ends its CLAIM shares
 * (CLAIM_CLOSED) and cancels requests still open.
 */
export const claimDocumentsLifecycle: DomainEventConsumer = {
  name: "claim-documents-lifecycle",
  handles: ["ClaimSettled", "ClaimStatusChanged"],
  async handle(event) {
    const p = event.payload as { claimId?: string; stage?: string; to?: string };
    if (!p.claimId) return;
    if (event.eventType === "ClaimSettled" && p.stage !== "SETTLED") return;
    if (event.eventType === "ClaimStatusChanged" && p.to !== "CLOSED") return;
    const rows = await prisma.claimDocumentRequest.findMany({ where: { claimId: p.claimId, status: { in: ["OPEN", "FULFILLED"] } } });
    for (const r of rows) {
      await prisma.$transaction(async (tx) => {
        if (r.shareId) await endShareTx(tx, r.shareId, "ENDED", "CLAIM_CLOSED", event.actorUserId);
        if (r.status === "OPEN") {
          const u = await tx.claimDocumentRequest.updateMany({ where: { id: r.id, status: "OPEN" }, data: { status: "CANCELLED", version: { increment: 1 } } });
          if (u.count === 1) await changedTx(tx, r, "OPEN", "CANCELLED", event.actorUserId);
        }
      });
    }
  },
};
