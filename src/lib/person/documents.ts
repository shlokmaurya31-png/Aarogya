import type { PersonDocument } from "@prisma/client";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { getStorageAdapter } from "@/lib/storage";
import { emitDomainEvent } from "@/lib/events/emit";
import { resolvePatientIdsForRead } from "@/lib/patient/merge";
import { logRecordAccess } from "@/lib/sharing/accessLog";
import { sharedDocumentVisible } from "@/lib/sharing/history";
import { personAccess, personDecision, requireOwnedPerson, SHARE_UPLOADS } from "./access";

/**
 * Phase 0, part 2 — person-level documents (docs/PERSON_IDENTITY_DESIGN.md §7).
 * An upload is the person's, tied to no facility. Who may read it:
 *   the person (their OWNER login): all of their CURRENT documents;
 *   staff of a facility, about a record there that is linked to the person:
 *     - if the person chose to share uploads with hospitals treating them,
 *       all of them, while that facility has a care relationship (resolver);
 *     - if they haven't chosen yet, only uploads made before Phase 0 to that
 *       facility's record (legacyFacilityId/legacyPatientId);
 *     - if they declined, none.
 *   a doctor holding a share with UPLOADS (Week 4c fix): the uploads the share
 *     shows (its period and sensitive opt-ins), while the share is live.
 * Bytes are read only through a short-lived (5-minute) signed URL after that
 * decision; a staff read is audited and written to the person's access log.
 */

export const PERSON_DOCUMENT_TYPES = ["REPORT", "REFERRAL_LETTER", "ID_PROOF", "OTHER"] as const;
const SIGNED_URL_SECONDS = 300;

export async function uploadPersonDocument(userId: string, input: { bytes: Buffer; contentType: string; originalName: string; title: string; type: string }) {
  return uploadPersonDocumentFor(await requireOwnedPerson(userId), userId, input);
}

/**
 * Week 5b: the upload itself, for a Person, by a user who may upload there:
 * the person's own login (above), or a proxy whose UPLOAD grant the caller
 * has already checked (src/lib/household/proxy.ts). The uploader is recorded.
 */
export async function uploadPersonDocumentFor(personId: string, userId: string, input: { bytes: Buffer; contentType: string; originalName: string; title: string; type: string }) {
  if (!(PERSON_DOCUMENT_TYPES as readonly string[]).includes(input.type)) throw new BadRequestError(`type must be one of ${PERSON_DOCUMENT_TYPES.join(", ")}.`);
  const title = input.title.trim().slice(0, 200);
  if (!title) throw new BadRequestError("A title is required.");
  const storage = getStorageAdapter();
  const stored = await storage.put({ bucket: "patient-uploads", bytes: input.bytes, contentType: input.contentType, originalName: input.originalName, scope: personId });
  try {
    const doc = await prisma.$transaction(async (tx) => {
      const created = await tx.personDocument.create({
        data: { personId, type: input.type, title, storageRef: stored.storageRef, sha256: stored.sha256, contentType: stored.contentType, uploadedByUserId: userId },
      });
      await emitDomainEvent(tx, {
        type: "PersonDocumentUploaded", aggregateId: created.id, personId, actorUserId: userId,
        payload: { personId, documentId: created.id, documentType: input.type as (typeof PERSON_DOCUMENT_TYPES)[number] },
      });
      return created;
    });
    await recordAuditEvent("person.document.uploaded", userId, { personId, documentId: doc.id, type: doc.type, sha256: doc.sha256 });
    return doc;
  } catch (err) {
    await storage.delete(stored.storageRef).catch(() => undefined);
    throw err;
  }
}

/** The person's own documents (owner only). */
export async function listOwnDocuments(userId: string) {
  const personId = await requireOwnedPerson(userId);
  return prisma.personDocument.findMany({ where: { personId, status: "CURRENT" }, orderBy: [{ uploadedAt: "desc" }, { id: "desc" }] });
}

/** The person documents staff of `facilityId` may see for these records (merge-aware ids). */
export async function staffPersonDocuments(facilityId: string, patientIds: string[]): Promise<PersonDocument[]> {
  const links = await prisma.personPatientLink.findMany({
    where: { patientId: { in: patientIds }, facilityId, status: { in: ["ACTIVE", "REVERIFICATION_REQUIRED", "PENDING_VERIFICATION"] } },
    select: { personId: true, status: true },
  });
  const out: PersonDocument[] = [];
  for (const personId of [...new Set(links.map((l) => l.personId))]) {
    const decision = await personDecision(personId, SHARE_UPLOADS);
    if (decision === "GRANTED") {
      if (await personAccess({ kind: "STAFF", userId: "", facilityId }, personId, "UPLOADS")) {
        out.push(...(await prisma.personDocument.findMany({ where: { personId, status: "CURRENT" }, orderBy: [{ uploadedAt: "desc" }, { id: "desc" }] })));
      }
    } else if (decision === null) {
      out.push(...(await prisma.personDocument.findMany({ where: { personId, status: "CURRENT", legacyFacilityId: facilityId, legacyPatientId: { in: patientIds } }, orderBy: [{ uploadedAt: "desc" }, { id: "desc" }] })));
    }
  }
  return out;
}

/** The person documents of the people linked to these records, for the patient's own views. */
export async function linkedPersonDocuments(patientIds: string[]): Promise<PersonDocument[]> {
  const links = await prisma.personPatientLink.findMany({ where: { patientId: { in: patientIds }, status: "ACTIVE" }, select: { personId: true } });
  const persons = [...new Set(links.map((l) => l.personId))];
  if (!persons.length) return [];
  return prisma.personDocument.findMany({ where: { personId: { in: persons }, status: "CURRENT" }, orderBy: [{ uploadedAt: "desc" }, { id: "desc" }] });
}

export type DocumentActor =
  | { kind: "OWNER"; userId: string }
  | { kind: "STAFF"; userId: string; facilityId: string; patientId: string }
  /** Week 4c fix: a doctor holding a share with UPLOADS (a code session id or an approved request's share id). */
  | { kind: "SHARE"; userId: string; facilityId: string; role: string; shareRef: string };

/** A signed URL for one document, after the access decision. 404 when the actor may not read it. */
export async function personDocumentDownload(actor: DocumentActor, documentId: string) {
  const doc = await prisma.personDocument.findUnique({ where: { id: documentId } });
  if (!doc || doc.status !== "CURRENT") throw new NotFoundError();
  if (actor.kind === "OWNER") {
    if ((await requireOwnedPerson(actor.userId)) !== doc.personId) throw new NotFoundError();
  } else if (actor.kind === "SHARE") {
    // The access check first (the resolver, then the share's own filters); only then a 5-minute URL.
    const grant = await personAccess(actor, doc.personId, "UPLOADS");
    if (!grant?.share || !sharedDocumentVisible(grant.share, doc)) throw new NotFoundError();
    await logRecordAccess({ personId: doc.personId, actorUserId: actor.userId, facilityId: actor.facilityId, via: grant.share.via, surface: "DOCUMENT_DOWNLOAD", shareId: grant.share.shareId ?? grant.share.ref, categories: ["UPLOADS"], documentId: doc.id });
    // The record shared may be another facility's: it goes in the detail, not the facility-scoped patient column.
    await recordAuditEvent("person.document.accessedViaShare", actor.userId, { documentId: doc.id, personId: doc.personId, shareId: grant.share.shareId ?? grant.share.ref, via: grant.share.via, subjectPatientId: grant.share.subjectPatientId }, { facilityId: actor.facilityId });
  } else {
    const patient = await prisma.patient.findUnique({ where: { id: actor.patientId }, select: { facilityId: true } });
    if (!patient || patient.facilityId !== actor.facilityId) throw new NotFoundError();
    const visible = await staffPersonDocuments(actor.facilityId, await resolvePatientIdsForRead(actor.patientId));
    if (!visible.some((d) => d.id === doc.id)) throw new NotFoundError();
    await prisma.personAccessLogEntry.create({ data: { personId: doc.personId, kind: "RECORD_ACCESSED", accessingFacilityId: actor.facilityId, actorUserId: actor.userId, detail: { documentId: doc.id } } });
    await recordAuditEvent("person.document.accessed", actor.userId, { documentId: doc.id, personId: doc.personId }, { facilityId: actor.facilityId, patientId: actor.patientId });
  }
  const { url, expiresAt } = await getStorageAdapter().signedDownloadUrl(doc.storageRef, SIGNED_URL_SECONDS);
  return { title: doc.title, url, expiresAt: expiresAt.toISOString() };
}

/** The person withdraws one of their documents: hidden everywhere; the bytes are kept until the account is closed. */
export async function withdrawPersonDocument(userId: string, documentId: string) {
  const personId = await requireOwnedPerson(userId);
  const doc = await prisma.personDocument.findUnique({ where: { id: documentId } });
  if (!doc || doc.personId !== personId) throw new NotFoundError();
  if (doc.status !== "CURRENT") return { status: doc.status };
  await prisma.$transaction(async (tx) => {
    const r = await tx.personDocument.updateMany({ where: { id: doc.id, status: "CURRENT" }, data: { status: "WITHDRAWN", withdrawnAt: new Date() } });
    if (r.count !== 1) return;
    await emitDomainEvent(tx, { type: "PersonDocumentWithdrawn", aggregateId: doc.id, personId, actorUserId: userId, payload: { personId, documentId: doc.id } });
  });
  return { status: "WITHDRAWN" as const };
}

// ── Moving pre-part-2 uploads (refuse rather than guess) ───────────────────

/**
 * What can point at a ClinicalDocument. There are no foreign keys: these are
 * plain id columns (compliance evidence, credential and privilege documents,
 * claim submission documents) and a comma-separated list (claim query
 * responses). A moved row must have none of them in use. Keep in step with
 * the schema (documents.test.ts checks every `documentId` column is listed).
 */
export const CLINICAL_DOCUMENT_REFERENCES = ["ComplianceEvidence", "Credential", "StaffPrivilege", "ClaimSubmissionDocument"] as const;

async function isReferenced(documentId: string): Promise<boolean> {
  const counts = await Promise.all([
    prisma.complianceEvidence.count({ where: { documentId } }),
    prisma.credential.count({ where: { documentId } }),
    prisma.staffPrivilege.count({ where: { documentId } }),
    prisma.claimSubmissionDocument.count({ where: { documentId } }),
    prisma.claimQuery.count({ where: { responseDocumentIds: { contains: documentId } } }),
  ]);
  return counts.some((n) => n > 0);
}

export type UploadMoveRefusal = { documentId: string; reason: "NO_FILE" | "NOT_CURRENT" | "NOT_PATIENT_VISIBLE" | "REFERENCED" };

/**
 * Moves each patient upload that already has an owning Person
 * (ClinicalDocument.personId) to PersonDocument: same bytes (storageRef,
 * sha256), the pre-Phase-0 visibility carried as legacyFacilityId/
 * legacyPatientId, and the ClinicalDocument row deleted in the same
 * transaction. Refused, and left exactly as it is: no file, a superseded or
 * draft version, an unexpected access policy, or a row something else
 * references (a claim attachment, quality evidence, …).
 */
export async function movePersonUploads(opts: { dryRun: boolean; onlyPersonIds?: string[]; alsoUploadedBy?: string[] }) {
  // A dry run also plans uploads whose owner the account step would only now assign (alsoUploadedBy).
  const owned = { personId: opts.onlyPersonIds ? { in: opts.onlyPersonIds } : { not: null }, uploadedByUserId: { not: null } };
  const rows = await prisma.clinicalDocument.findMany({
    where: opts.alsoUploadedBy?.length ? { OR: [owned, { personId: null, uploadedByUserId: { in: opts.alsoUploadedBy } }] } : owned,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const refusals: UploadMoveRefusal[] = [];
  let moved = 0;
  for (const d of rows) {
    let reason: UploadMoveRefusal["reason"] | null = null;
    if (!d.storageRef || !d.sha256) reason = "NO_FILE";
    else if (d.status !== "CURRENT") reason = "NOT_CURRENT";
    else if (d.accessPolicy !== "PATIENT_VISIBLE") reason = "NOT_PATIENT_VISIBLE";
    else if (await isReferenced(d.id)) reason = "REFERENCED";
    if (reason) { refusals.push({ documentId: d.id, reason }); continue; }
    moved += 1;
    if (opts.dryRun) continue;
    await prisma.$transaction(async (tx) => {
      await tx.personDocument.create({
        data: {
          personId: d.personId!, type: d.type, title: d.title, storageRef: d.storageRef!, sha256: d.sha256!, uploadedByUserId: d.uploadedByUserId!, uploadedAt: d.createdAt,
          legacyFacilityId: d.legacyFacilityVisible ? d.facilityId : null, legacyPatientId: d.patientId, movedFromClinicalDocumentId: d.id,
        },
      });
      await tx.clinicalDocument.delete({ where: { id: d.id } });
    });
  }
  return { considered: rows.length, moved, refusals };
}
