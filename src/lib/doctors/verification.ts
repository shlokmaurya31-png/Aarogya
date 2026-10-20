import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { getStorageAdapter } from "@/lib/storage";
import { requireOwnDoctor } from "./profile";
import { VERIFICATION_REASONS, VERIFICATION_TARGET_HOURS, type VerificationReason } from "./vocab";

/**
 * Week 5a — verification first (docs/DOCTOR_NETWORK_DESIGN.md §4). The doctor
 * submits their registration certificate and degree; the platform team
 * (permission doctor:verify, held by the platform admin only, never a
 * facility admin) checks them by hand against the council's register within
 * the 48-hour target and approves (confirming the registration year shown as
 * "registered since") or rejects with a closed reason code. Nothing is public
 * or bookable before VERIFIED. SUSPENDED removes the doctor from search and
 * new bookings at once; existing appointments stay. HPR is a later adapter.
 * Documents are readable only by the doctor and the verifier (5-minute signed
 * URLs, audited) and deleted 90 days after the decision; the decision stays.
 */
const SIGNED_URL_SECONDS = 300;
export const DOCUMENT_RETENTION_DAYS = 90;

async function statusTx(tx: Prisma.TransactionClient, doctorId: string, from: string, to: "PENDING" | "VERIFIED" | "REJECTED" | "SUSPENDED" | "UNVERIFIED", actorUserId: string, extra: { method?: string; reasonCode?: string; registrationYear?: number | null } = {}) {
  const r = await tx.doctorProfile.updateMany({
    where: { id: doctorId, verificationStatus: from as never },
    data: {
      verificationStatus: to, version: { increment: 1 },
      ...(to === "VERIFIED" ? { verifiedAt: new Date(), verificationMethod: extra.method ?? "DOCUMENT_CHECK", ...(extra.registrationYear !== undefined ? { registrationYear: extra.registrationYear } : {}) } : {}),
      // Not verified any more: off the directory until verified again and the doctor lists themselves again.
      ...(to === "SUSPENDED" || to === "REJECTED" ? { listed: false } : {}),
    },
  });
  if (r.count !== 1) throw new ConflictError("The doctor's status changed in the meantime.");
  await emitDomainEvent(tx, {
    type: "DoctorVerificationStatusChanged", aggregateId: doctorId, actorUserId,
    payload: { doctorId, from, to, ...(extra.method ? { method: extra.method } : {}), ...(extra.reasonCode ? { reasonCode: extra.reasonCode } : {}) },
  });
}

async function caseEventTx(tx: Prisma.TransactionClient, c: { id: string; doctorId: string }, from: "OPEN" | "INFO_REQUESTED" | "APPROVED" | "REJECTED" | null, to: "OPEN" | "INFO_REQUESTED" | "APPROVED" | "REJECTED" | "DOCUMENTS_PURGED", actorUserId: string | null, reasonCode?: string) {
  await emitDomainEvent(tx, { type: "DoctorVerificationCaseChanged", aggregateId: c.id, actorUserId, payload: { caseId: c.id, doctorId: c.doctorId, from, to, ...(reasonCode ? { reasonCode } : {}) } });
}

/** The doctor submits documents (PDF or image) for the check: one open case at a time. */
export async function submitVerification(userId: string, files: { bytes: Buffer; contentType: string; originalName: string }[]) {
  const d = await requireOwnDoctor(userId);
  if (!files.length || files.length > 4) throw new BadRequestError("Attach your registration certificate and degree (1–4 files).");
  if (d.verificationStatus === "VERIFIED") throw new ConflictError("Your registration is already verified.");
  if (d.verificationStatus === "SUSPENDED") throw new ConflictError("Your profile is suspended. Contact support.");
  if (await prisma.doctorVerificationCase.findFirst({ where: { doctorId: d.id, status: "OPEN" }, select: { id: true } })) {
    throw new ConflictError("Your documents are already with the platform team.");
  }
  // The team asked for more: the new documents join that case, which is open again with a fresh 48 hours.
  const asked = await prisma.doctorVerificationCase.findFirst({ where: { doctorId: d.id, status: "INFO_REQUESTED" } });
  const storage = getStorageAdapter();
  const refs: string[] = [];
  try {
    for (const f of files) refs.push((await storage.put({ bucket: "verification", bytes: f.bytes, contentType: f.contentType, originalName: f.originalName, scope: `doctor-${d.id}` })).storageRef);
    const c = await prisma.$transaction(async (tx) => {
      const dueAt = new Date(Date.now() + VERIFICATION_TARGET_HOURS * 3_600_000);
      if (asked) {
        const r = await tx.doctorVerificationCase.updateMany({ where: { id: asked.id, status: "INFO_REQUESTED" }, data: { status: "OPEN", documentRefs: [...asked.documentRefs, ...refs], dueAt, version: { increment: 1 } } });
        if (r.count !== 1) throw new ConflictError("Your case changed in the meantime. Try again.");
        await caseEventTx(tx, asked, "INFO_REQUESTED", "OPEN", userId);
        return { ...asked, dueAt };
      }
      const c = await tx.doctorVerificationCase.create({ data: { doctorId: d.id, documentRefs: refs, dueAt } });
      await caseEventTx(tx, c, null, "OPEN", userId);
      if (d.verificationStatus === "UNVERIFIED" || d.verificationStatus === "REJECTED") await statusTx(tx, d.id, d.verificationStatus, "PENDING", userId);
      return c;
    });
    await recordAuditEvent("doctor.verification.submitted", userId, { doctorId: d.id, caseId: c.id, files: refs.length });
    return { caseId: c.id, dueAt: c.dueAt.toISOString() };
  } catch (err) {
    for (const r of refs) await storage.delete(r).catch(() => undefined);
    throw err;
  }
}

/** The verifier's queue: open cases, oldest due first, with what the register check needs (no document bytes). */
export async function verificationQueue() {
  const cases = await prisma.doctorVerificationCase.findMany({
    where: { status: { in: ["OPEN", "INFO_REQUESTED"] } }, orderBy: { dueAt: "asc" }, take: 100,
    include: { doctor: { select: { id: true, displayName: true, registrationNumber: true, stateCouncil: true, registrationYear: true, qualifications: true, specialties: true } } },
  });
  const now = Date.now();
  return cases.map((c) => ({ id: c.id, status: c.status, dueAt: c.dueAt.toISOString(), overdue: c.dueAt.getTime() < now, documents: c.documentRefs.length, doctor: c.doctor }));
}

/** A 5-minute URL for one case document: the doctor themselves or the verifier, audited. */
export async function caseDocumentUrl(actor: { userId: string; verifier: boolean }, caseId: string, index: number) {
  const c = await prisma.doctorVerificationCase.findUnique({ where: { id: caseId }, include: { doctor: { select: { userId: true } } } });
  if (!c || (!actor.verifier && c.doctor.userId !== actor.userId) || c.documentsPurgedAt) throw new NotFoundError();
  const ref = c.documentRefs[index];
  if (!ref) throw new NotFoundError();
  await recordAuditEvent("doctor.verification.documentViewed", actor.userId, { caseId, index, byVerifier: actor.verifier });
  const { url, expiresAt } = await getStorageAdapter().signedDownloadUrl(ref, SIGNED_URL_SECONDS);
  return { url, expiresAt: expiresAt.toISOString() };
}

/** The verifier decides: APPROVE (confirming the registration year), REJECT or ASK_MORE, each with a closed reason. */
export async function decideVerification(verifierUserId: string, caseId: string, body: { decision?: unknown; reasonCode?: unknown; registrationYear?: unknown } | null) {
  const b = body ?? {};
  const c = await prisma.doctorVerificationCase.findUnique({ where: { id: caseId }, include: { doctor: true } });
  if (!c) throw new NotFoundError();
  if (c.status !== "OPEN" && c.status !== "INFO_REQUESTED") throw new ConflictError("This case has been decided.");
  if (c.doctor.userId === verifierUserId) throw new BadRequestError("You can't verify your own registration.");
  const reason = b.reasonCode === undefined ? undefined : String(b.reasonCode);
  if (reason !== undefined && !(VERIFICATION_REASONS as readonly string[]).includes(reason)) throw new BadRequestError(`reasonCode must be one of ${VERIFICATION_REASONS.join(", ")}.`);
  const decision = b.decision;
  if (decision === "APPROVE") {
    const year = b.registrationYear === undefined || b.registrationYear === null ? c.doctor.registrationYear : Number(b.registrationYear);
    if (year !== null && (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear())) throw new BadRequestError("registrationYear is not valid.");
    await prisma.$transaction(async (tx) => {
      const r = await tx.doctorVerificationCase.updateMany({ where: { id: c.id, status: c.status }, data: { status: "APPROVED", reviewerUserId: verifierUserId, decidedAt: new Date(), confirmedRegistrationYear: year, version: { increment: 1 } } });
      if (r.count !== 1) throw new ConflictError("This case has been decided.");
      await caseEventTx(tx, c, c.status, "APPROVED", verifierUserId);
      await statusTx(tx, c.doctorId, c.doctor.verificationStatus, "VERIFIED", verifierUserId, { method: "DOCUMENT_CHECK", registrationYear: year });
    });
  } else if (decision === "REJECT" || decision === "ASK_MORE") {
    if (!reason) throw new BadRequestError("A reasonCode is required.");
    await prisma.$transaction(async (tx) => {
      const to = decision === "REJECT" ? "REJECTED" : "INFO_REQUESTED";
      const r = await tx.doctorVerificationCase.updateMany({ where: { id: c.id, status: c.status }, data: { status: to, reviewerUserId: verifierUserId, reasonCode: reason as VerificationReason, decidedAt: decision === "REJECT" ? new Date() : null, version: { increment: 1 } } });
      if (r.count !== 1) throw new ConflictError("This case has been decided.");
      await caseEventTx(tx, c, c.status, to, verifierUserId, reason);
      if (decision === "REJECT") await statusTx(tx, c.doctorId, c.doctor.verificationStatus, "REJECTED", verifierUserId, { reasonCode: reason });
    });
  } else {
    throw new BadRequestError("decision must be APPROVE, REJECT or ASK_MORE.");
  }
  await recordAuditEvent("doctor.verification.decided", verifierUserId, { caseId, doctorId: c.doctorId, decision, reasonCode: reason ?? null });
  return prisma.doctorProfile.findUniqueOrThrow({ where: { id: c.doctorId }, select: { id: true, verificationStatus: true, registrationYear: true, listed: true } });
}

/** The platform team suspends a verified doctor (a complaint or a council action): out of search and new bookings at once. */
export async function suspendDoctor(verifierUserId: string, doctorId: string, reasonCode: unknown) {
  if (typeof reasonCode !== "string" || !(VERIFICATION_REASONS as readonly string[]).includes(reasonCode)) throw new BadRequestError("A reasonCode is required.");
  const d = await prisma.doctorProfile.findUnique({ where: { id: doctorId } });
  if (!d) throw new NotFoundError();
  if (d.verificationStatus !== "VERIFIED") throw new ConflictError("Only a verified doctor can be suspended.");
  await prisma.$transaction((tx) => statusTx(tx, d.id, "VERIFIED", "SUSPENDED", verifierUserId, { reasonCode }));
  await recordAuditEvent("doctor.suspended", verifierUserId, { doctorId, reasonCode });
  return { verificationStatus: "SUSPENDED" as const };
}

/** Runner sweep: documents of cases decided 90+ days ago are deleted; the decision stays. */
export async function purgeVerificationDocuments(opts: { now?: Date } = {}): Promise<{ purged: number }> {
  const before = new Date((opts.now ?? new Date()).getTime() - DOCUMENT_RETENTION_DAYS * 86_400_000);
  const due = await prisma.doctorVerificationCase.findMany({ where: { decidedAt: { lt: before }, documentsPurgedAt: null, status: { in: ["APPROVED", "REJECTED"] } }, take: 100 });
  const storage = getStorageAdapter();
  let purged = 0;
  for (const c of due) {
    for (const ref of c.documentRefs) await storage.delete(ref).catch(() => undefined);
    await prisma.$transaction(async (tx) => {
      const r = await tx.doctorVerificationCase.updateMany({ where: { id: c.id, documentsPurgedAt: null }, data: { documentRefs: [], documentsPurgedAt: new Date(), version: { increment: 1 } } });
      if (r.count !== 1) return;
      await caseEventTx(tx, c, c.status as "APPROVED" | "REJECTED", "DOCUMENTS_PURGED", null);
      purged += 1;
    });
  }
  return { purged };
}
