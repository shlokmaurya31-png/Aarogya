import { createHash } from "node:crypto";
import { Prisma, type KnowledgeAccessClass, type KnowledgeDocumentType, type Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { getStorageAdapter } from "@/lib/storage";
import { detectFormat, FORMAT_MESSAGES, type KnowledgeFormat } from "./formats";
import { documentText, KnowledgeParseError, parseKnowledgeFile, type ParseRefusal } from "./parse";
import { findPatientIdentifiers } from "./identifiers";
import { KnowledgeError } from "./errors";
import { publishKnowledgeVersion, retireKnowledgeIndex } from "./publish";

type Tx = Prisma.TransactionClient;

/**
 * RAG Phase 2 — knowledge documents (docs/RAG_IMPLEMENTATION_PLAN.md §4; §13
 * decisions 4, 7, 8; §13.3 A).
 *
 *   upload     a hospital administrator (knowledge:manage) uploads a file as a
 *              new document or as the next version of one; it is checked
 *              (type and bytes, size, parsed, patient identifiers) BEFORE
 *              anything is stored, so a refused file leaves nothing behind;
 *              then stored, recorded SUBMITTED and queued for ingestion
 *              (KnowledgeDocumentVersionUploaded, bulk lane)
 *   approve    a second person (knowledge:approve: medical superintendent,
 *              quality lead) approves an INDEXED version; never the uploader
 *              (refused here, and by a database CHECK). In force now: published
 *              in the same transaction, the version before it superseded
 *   reject     the approver turns a version down, with a reason (audited)
 *   withdraw   a hospital administrator takes a version out of use
 *   re-run     a FAILED ingestion is queued again
 * Every read and write is scoped in SQL: the actor's organisation, and their
 * facility or the organisation as a whole. Another facility's document is
 * a 404, never a 403. Responses carry no hash, no storage reference and no
 * file contents.
 */
export interface KnowledgeActor {
  userId: string;
  role: Role;
  facilityId: string;
  organizationId: string;
  orgAdmin: boolean;
}

export const KNOWLEDGE_TYPES: KnowledgeDocumentType[] = ["SOP", "POLICY", "CLINICAL_REFERENCE", "FORMULARY", "ADMIN", "EDUCATIONAL"];
export const KNOWLEDGE_CLASSES: KnowledgeAccessClass[] = ["ALL_STAFF", "CLINICAL", "PHARMACY", "BILLING", "ADMIN"];

/** The documents an actor may see: their organisation's, for their facility or organisation-wide. In SQL. */
export function knowledgeScope(a: Pick<KnowledgeActor, "organizationId" | "facilityId">): Prisma.KnowledgeDocumentWhereInput {
  return { organizationId: a.organizationId, OR: [{ facilityId: null }, { facilityId: a.facilityId }] };
}

const PARSE_MESSAGES: Record<ParseRefusal, string> = {
  UNREADABLE: "The file couldn't be read.",
  NO_TEXT_LAYER: "A page of this PDF is a scanned image with no text. Upload a PDF with selectable text.",
  NO_TEXT: "The file has no text to index.",
  TOO_MANY_PAGES: "The PDF has more than 500 pages. Split it into parts.",
};
const KIND_TEXT: Record<string, string> = {
  ABHA_NUMBER: "an ABHA number", AADHAAR_NUMBER: "an Aadhaar-like number", MOBILE_NUMBER: "a mobile number",
  UHID_OR_MRN: "a UHID or MRN", NAME_WITH_AGE: "a name with an age",
};

export interface UploadInput {
  documentId?: string;
  title?: string;
  description?: string | null;
  documentType?: string;
  accessClass?: string;
  scope?: "FACILITY" | "ORGANIZATION";
  language?: string;
  effectiveAt?: Date | null;
  expiresAt?: Date | null;
  fileName: string;
  declaredType?: string | null;
  bytes: Buffer;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const cleanName = (n: string) => n.replace(/\\/g, "/").split("/").pop()!.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(-120) || "file";

function checkWindow(effectiveAt: Date | null | undefined, expiresAt: Date | null | undefined, now: Date) {
  for (const d of [effectiveAt, expiresAt]) if (d && Number.isNaN(d.getTime())) throw new KnowledgeError(400, "WINDOW", "A date isn't valid.");
  if (expiresAt && expiresAt <= now) throw new KnowledgeError(400, "WINDOW", "The expiry date must be in the future.");
  if (effectiveAt && expiresAt && effectiveAt >= expiresAt) throw new KnowledgeError(400, "WINDOW", "The effective date must be before the expiry date.");
}

async function refuseIdentifiers(actor: KnowledgeActor, kinds: string[]) {
  // Nothing of the file is kept: the audit names the refusal and the kinds found, no value and no file name.
  await recordAuditEvent("knowledge.upload.refused", actor.userId, { code: "CONTAINS_IDENTIFIERS", kinds }, { facilityId: actor.facilityId, organizationId: actor.organizationId });
  throw new KnowledgeError(400, "CONTAINS_IDENTIFIERS", `This file looks like it contains patient identifiers (${kinds.map((k) => KIND_TEXT[k] ?? k).join(", ")}). Knowledge documents must not name patients. Remove them and upload again.`, kinds);
}

/** Checks a file without storing anything: its format, then its text, then patient identifiers. */
export async function checkKnowledgeFile(actor: KnowledgeActor, input: { fileName: string; declaredType?: string | null; bytes: Buffer; title?: string; description?: string | null }): Promise<{ format: KnowledgeFormat; contentType: string; pageCount: number | null }> {
  const det = detectFormat(input);
  if (!det.ok) throw new KnowledgeError(400, det.code, FORMAT_MESSAGES[det.code]);
  const metaKinds = findPatientIdentifiers([input.fileName, input.title ?? "", input.description ?? ""].join("\n"));
  if (metaKinds.length) await refuseIdentifiers(actor, metaKinds);
  let parsed;
  try {
    parsed = await parseKnowledgeFile(det.format, input.bytes);
  } catch (err) {
    if (err instanceof KnowledgeParseError) throw new KnowledgeError(400, err.code, PARSE_MESSAGES[err.code]);
    if (err instanceof SyntaxError) throw new KnowledgeError(400, "TYPE_MISMATCH", FORMAT_MESSAGES.TYPE_MISMATCH);
    throw err;
  }
  const kinds = findPatientIdentifiers(documentText(parsed));
  if (kinds.length) await refuseIdentifiers(actor, kinds);
  return { format: det.format, contentType: det.contentType, pageCount: parsed.pageCount };
}

export async function uploadKnowledge(actor: KnowledgeActor, input: UploadInput, now = new Date()): Promise<{ documentId: string; versionId: string; version: number }> {
  checkWindow(input.effectiveAt, input.expiresAt, now);
  const language = input.language ?? "en";
  if (!/^[a-z]{2}$/.test(language)) throw new KnowledgeError(400, "INVALID", "The language must be a two-letter code.");

  let existing: { id: string; facilityId: string | null; title: string; description: string | null } | null = null;
  if (input.documentId) {
    existing = await prisma.knowledgeDocument.findFirst({ where: { id: input.documentId, ...knowledgeScope(actor) }, select: { id: true, facilityId: true, title: true, description: true } });
    if (!existing) throw new NotFoundError();
    if (existing.facilityId === null && !actor.orgAdmin) throw new KnowledgeError(403, "ORGANIZATION_ADMIN_ONLY", "Only an organisation administrator manages an organisation-wide document.");
  } else {
    const title = (input.title ?? "").trim();
    if (title.length < 3 || title.length > 200) throw new KnowledgeError(400, "INVALID", "A title of 3 to 200 characters is required.");
    if (!KNOWLEDGE_TYPES.includes(input.documentType as KnowledgeDocumentType)) throw new KnowledgeError(400, "INVALID", "Choose the kind of document.");
    if (!KNOWLEDGE_CLASSES.includes(input.accessClass as KnowledgeAccessClass)) throw new KnowledgeError(400, "INVALID", "Choose who may read it.");
    if (input.scope === "ORGANIZATION" && !actor.orgAdmin) throw new KnowledgeError(403, "ORGANIZATION_ADMIN_ONLY", "Only an organisation administrator uploads an organisation-wide document.");
  }

  const checked = await checkKnowledgeFile(actor, { ...input, title: existing?.title ?? input.title, description: existing ? existing.description : input.description });
  const hash = sha256(input.bytes);
  if (existing && (await prisma.knowledgeDocumentVersion.findFirst({ where: { documentId: existing.id, sha256: hash }, select: { id: true } }))) {
    throw new KnowledgeError(409, "DUPLICATE", "This exact file is already a version of this document.");
  }

  const stored = await getStorageAdapter().put({ bucket: "knowledge-documents", bytes: input.bytes, contentType: checked.contentType, originalName: `${hash.slice(0, 8)}.${checked.format.toLowerCase()}`, scope: actor.organizationId });
  try {
    return await prisma.$transaction(async (tx) => {
      let documentId = existing?.id;
      if (!documentId) {
        const doc = await tx.knowledgeDocument.create({
          data: {
            organizationId: actor.organizationId, facilityId: input.scope === "ORGANIZATION" ? null : actor.facilityId,
            type: input.documentType as KnowledgeDocumentType, accessClass: input.accessClass as KnowledgeAccessClass,
            title: input.title!.trim(), description: input.description?.trim() || null, ownerUserId: actor.userId,
          },
        });
        documentId = doc.id;
        await emitDomainEvent(tx, {
          type: "KnowledgeDocumentCreated", aggregateId: doc.id, organizationId: actor.organizationId, facilityId: doc.facilityId ?? undefined, actorUserId: actor.userId,
          payload: { documentId: doc.id, documentType: doc.type, accessClass: doc.accessClass, scope: doc.facilityId ? "FACILITY" : "ORGANIZATION" },
        });
      }
      // Serialise versions of one document (the version number), with the duplicate re-checked under the lock.
      await tx.$queryRaw`SELECT "id" FROM "KnowledgeDocument" WHERE "id" = ${documentId} FOR UPDATE`;
      if (await tx.knowledgeDocumentVersion.findFirst({ where: { documentId, sha256: hash }, select: { id: true } })) throw new KnowledgeError(409, "DUPLICATE", "This exact file is already a version of this document.");
      const last = await tx.knowledgeDocumentVersion.findFirst({ where: { documentId }, orderBy: { version: "desc" }, select: { version: true } });
      const version = (last?.version ?? 0) + 1;
      const v = await tx.knowledgeDocumentVersion.create({
        data: {
          documentId, version, storageRef: stored.storageRef, sha256: hash, contentType: checked.contentType, format: checked.format, fileName: cleanName(input.fileName),
          language, byteSize: input.bytes.length, pageCount: checked.pageCount, uploadedByUserId: actor.userId,
          approvalStatus: "SUBMITTED", submittedAt: now, effectiveAt: input.effectiveAt ?? null, expiresAt: input.expiresAt ?? null,
        },
      });
      const doc = await tx.knowledgeDocument.findUniqueOrThrow({ where: { id: documentId }, select: { facilityId: true } });
      await emitDomainEvent(tx, {
        type: "KnowledgeDocumentVersionUploaded", aggregateId: documentId, organizationId: actor.organizationId, facilityId: doc.facilityId ?? undefined, actorUserId: actor.userId,
        payload: { documentId, versionId: v.id, version, format: checked.format, attempt: 1 },
      });
      await recordAuditEvent("knowledge.version.uploaded", actor.userId, { documentId, versionId: v.id, version, format: checked.format, byteSize: v.byteSize }, { facilityId: actor.facilityId, organizationId: actor.organizationId }, tx);
      return { documentId, versionId: v.id, version };
    });
  } catch (err) {
    // The row never committed: the stored object is removed (a duplicate's bytes are the other version's object, same reference, kept).
    const keep = await prisma.knowledgeDocumentVersion.findFirst({ where: { storageRef: stored.storageRef }, select: { id: true } });
    if (!keep) await getStorageAdapter().delete(stored.storageRef).catch(() => undefined);
    throw err;
  }
}

async function versionInScope(db: Tx | typeof prisma, actor: KnowledgeActor, versionId: string, lock = false) {
  const v = await db.knowledgeDocumentVersion.findFirst({ where: { id: versionId, document: knowledgeScope(actor) }, include: { document: true } });
  if (!v) throw new NotFoundError();
  if (lock) await db.$queryRaw`SELECT "id" FROM "KnowledgeDocument" WHERE "id" = ${v.documentId} FOR UPDATE`;
  return lock ? (await db.knowledgeDocumentVersion.findUniqueOrThrow({ where: { id: versionId }, include: { document: true } })) : v;
}

const tenant = (doc: { organizationId: string; facilityId: string | null }) => ({ organizationId: doc.organizationId, facilityId: doc.facilityId ?? undefined });

export async function approveKnowledgeVersion(actor: KnowledgeActor, versionId: string, input: { effectiveAt?: Date | null; expiresAt?: Date | null } = {}, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const v = await versionInScope(tx, actor, versionId, true);
    if (v.uploadedByUserId === actor.userId) throw new KnowledgeError(403, "SELF_APPROVAL", "You uploaded this version, so someone else must approve it.");
    if (v.withdrawnAt) throw new KnowledgeError(409, "ALREADY_WITHDRAWN", "This version was withdrawn.");
    if (v.approvalStatus !== "SUBMITTED") throw new KnowledgeError(409, "NOT_SUBMITTED", "This version isn't waiting for approval.");
    if (v.ingestionStatus !== "INDEXED") throw new KnowledgeError(409, "NOT_INDEXED", "This version hasn't finished processing; it can be approved once it is indexed.");
    const current = v.document.currentVersionId ? await tx.knowledgeDocumentVersion.findUnique({ where: { id: v.document.currentVersionId }, select: { version: true } }) : null;
    if (current && current.version > v.version) throw new KnowledgeError(409, "OLDER_THAN_CURRENT", "A newer version is already in force.");
    const effectiveAt = input.effectiveAt !== undefined ? input.effectiveAt : v.effectiveAt;
    const expiresAt = input.expiresAt !== undefined ? input.expiresAt : v.expiresAt;
    checkWindow(effectiveAt, expiresAt, now);
    await tx.knowledgeDocumentVersion.update({ where: { id: v.id }, data: { approvalStatus: "APPROVED", approvedByUserId: actor.userId, approvedAt: now, effectiveAt, expiresAt } });
    await emitDomainEvent(tx, {
      type: "KnowledgeDocumentApproved", aggregateId: v.documentId, ...tenant(v.document), actorUserId: actor.userId,
      payload: { documentId: v.documentId, versionId: v.id, ...(effectiveAt ? { effectiveAt: effectiveAt.toISOString() } : {}), ...(expiresAt ? { expiresAt: expiresAt.toISOString() } : {}) },
    });
    await recordAuditEvent("knowledge.version.approved", actor.userId, { documentId: v.documentId, versionId: v.id, version: v.version }, { facilityId: actor.facilityId, organizationId: actor.organizationId }, tx);
    const published = !effectiveAt || effectiveAt <= now ? await publishKnowledgeVersion(tx, v.id, now, actor.userId) : false;
    return { versionId: v.id, published };
  });
}

export async function rejectKnowledgeVersion(actor: KnowledgeActor, versionId: string, reason: string) {
  const why = (reason ?? "").trim();
  if (why.length < 3 || why.length > 500) throw new KnowledgeError(400, "INVALID", "A reason of 3 to 500 characters is required.");
  return prisma.$transaction(async (tx) => {
    const v = await versionInScope(tx, actor, versionId, true);
    if (v.withdrawnAt) throw new KnowledgeError(409, "ALREADY_WITHDRAWN", "This version was withdrawn.");
    if (v.approvalStatus !== "SUBMITTED") throw new KnowledgeError(409, "NOT_SUBMITTED", "This version isn't waiting for approval.");
    await tx.knowledgeDocumentVersion.update({ where: { id: v.id }, data: { approvalStatus: "REJECTED", rejectedReason: why } });
    await retireKnowledgeIndex(tx, v.id, "KNOWLEDGE_REJECTED");
    await emitDomainEvent(tx, { type: "KnowledgeDocumentRejected", aggregateId: v.documentId, ...tenant(v.document), actorUserId: actor.userId, payload: { documentId: v.documentId, versionId: v.id } });
    await recordAuditEvent("knowledge.version.rejected", actor.userId, { documentId: v.documentId, versionId: v.id, reason: why }, { facilityId: actor.facilityId, organizationId: actor.organizationId }, tx);
    return { versionId: v.id };
  });
}

export async function withdrawKnowledgeVersion(actor: KnowledgeActor, versionId: string, reason: string, now = new Date()) {
  const why = (reason ?? "").trim();
  if (why.length < 3 || why.length > 500) throw new KnowledgeError(400, "INVALID", "A reason of 3 to 500 characters is required.");
  return prisma.$transaction(async (tx) => {
    const v = await versionInScope(tx, actor, versionId, true);
    if (v.document.facilityId === null && !actor.orgAdmin) throw new KnowledgeError(403, "ORGANIZATION_ADMIN_ONLY", "Only an organisation administrator manages an organisation-wide document.");
    if (v.withdrawnAt) throw new KnowledgeError(409, "ALREADY_WITHDRAWN", "This version was already withdrawn.");
    const wasPublished = v.document.currentVersionId === v.id;
    await tx.knowledgeDocumentVersion.update({ where: { id: v.id }, data: { withdrawnAt: now } });
    if (wasPublished) await tx.knowledgeDocument.update({ where: { id: v.documentId }, data: { currentVersionId: null } });
    await retireKnowledgeIndex(tx, v.id, "KNOWLEDGE_WITHDRAWN");
    await emitDomainEvent(tx, { type: "KnowledgeDocumentWithdrawn", aggregateId: v.documentId, ...tenant(v.document), actorUserId: actor.userId, payload: { documentId: v.documentId, versionId: v.id, wasPublished } });
    await recordAuditEvent("knowledge.version.withdrawn", actor.userId, { documentId: v.documentId, versionId: v.id, reason: why, wasPublished }, { facilityId: actor.facilityId, organizationId: actor.organizationId }, tx);
    return { versionId: v.id, wasPublished };
  });
}

/** A FAILED ingestion queued again (the admin view's "re-run"). */
export async function retryKnowledgeIngestion(actor: KnowledgeActor, versionId: string) {
  return prisma.$transaction(async (tx) => {
    const v = await versionInScope(tx, actor, versionId, true);
    if (v.ingestionStatus !== "FAILED") throw new KnowledgeError(409, "NOT_FAILED", "Only a failed version can be re-run.");
    if (v.withdrawnAt || v.approvalStatus === "REJECTED") throw new KnowledgeError(409, "ALREADY_WITHDRAWN", "This version is out of use.");
    await tx.knowledgeDocumentVersion.update({ where: { id: v.id }, data: { ingestionStatus: "RECEIVED", ingestionError: null, ingestionAttempts: 0 } });
    await emitDomainEvent(tx, {
      type: "KnowledgeDocumentVersionUploaded", aggregateId: v.documentId, ...tenant(v.document), actorUserId: actor.userId,
      payload: { documentId: v.documentId, versionId: v.id, version: v.version, format: (v.format ?? "TEXT") as KnowledgeFormat, attempt: v.ingestionAttempts + 1 },
    });
    await recordAuditEvent("knowledge.ingestion.requeued", actor.userId, { documentId: v.documentId, versionId: v.id }, { facilityId: actor.facilityId, organizationId: actor.organizationId }, tx);
    return { versionId: v.id };
  });
}

// ── reads (the admin view) ─────────────────────────────────────────────────

export type VersionState = "PROCESSING" | "FAILED" | "AWAITING_APPROVAL" | "SCHEDULED" | "PUBLISHED" | "SUPERSEDED" | "EXPIRED" | "WITHDRAWN" | "REJECTED";

export function versionState(v: { id: string; ingestionStatus: string; approvalStatus: string; publishedAt: Date | null; supersededByVersionId: string | null; withdrawnAt: Date | null; expiresAt: Date | null }, currentVersionId: string | null, now = new Date()): VersionState {
  if (v.withdrawnAt) return "WITHDRAWN";
  if (v.approvalStatus === "REJECTED") return "REJECTED";
  if (v.supersededByVersionId) return "SUPERSEDED";
  if (v.publishedAt && v.id === currentVersionId) return v.expiresAt && v.expiresAt <= now ? "EXPIRED" : "PUBLISHED";
  if (v.publishedAt) return "EXPIRED";
  if (v.ingestionStatus === "FAILED") return "FAILED";
  if (v.ingestionStatus !== "INDEXED") return "PROCESSING";
  if (v.approvalStatus === "APPROVED") return "SCHEDULED";
  return "AWAITING_APPROVAL";
}

/** The admin view: every document in scope with its versions — status only, never a hash, a storage reference or file contents. */
export async function listKnowledge(actor: KnowledgeActor, now = new Date()) {
  const docs = await prisma.knowledgeDocument.findMany({
    where: knowledgeScope(actor),
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: 200,
    select: {
      id: true, title: true, description: true, type: true, accessClass: true, facilityId: true, currentVersionId: true, createdAt: true,
      versions: {
        orderBy: { version: "desc" },
        select: {
          id: true, version: true, fileName: true, format: true, language: true, byteSize: true, pageCount: true, uploadedByUserId: true, uploadedAt: true,
          approvalStatus: true, approvedByUserId: true, approvedAt: true, rejectedReason: true, effectiveAt: true, expiresAt: true, publishedAt: true,
          supersededByVersionId: true, withdrawnAt: true, ingestionStatus: true, ingestionAttempts: true, ingestionError: true, scanStatus: true,
          chunkCount: true, cacheHitCount: true, embeddedCount: true, indexedAt: true,
        },
      },
    },
  });
  const userIds = [...new Set(docs.flatMap((d) => d.versions.flatMap((v) => [v.uploadedByUserId, v.approvedByUserId]).filter((x): x is string => !!x)))];
  const names = new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
  return docs.map((d) => ({
    id: d.id, title: d.title, description: d.description, type: d.type, accessClass: d.accessClass, scope: d.facilityId ? "FACILITY" : "ORGANIZATION", createdAt: d.createdAt,
    versions: d.versions.map(({ uploadedByUserId, approvedByUserId, ...v }) => ({
      ...v,
      state: versionState(v, d.currentVersionId, now),
      uploadedBy: names.get(uploadedByUserId) ?? null,
      uploadedByMe: uploadedByUserId === actor.userId,
      approvedBy: approvedByUserId ? names.get(approvedByUserId) ?? null : null,
    })),
  }));
}
