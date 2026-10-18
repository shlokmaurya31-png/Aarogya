import { $Enums, type ClinicalDocument, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { parseEnum } from "@/lib/enumValue";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { DOCUMENT_TYPES } from "./templates";

/**
 * Documents staff record against a patient (batch 6, fix 2). They are created
 * final (CURRENT), so the create is the fact: ClinicalDocumentRecorded, in the
 * same transaction, with the type code and visibility, never the title or the
 * file. A new version supersedes the current one compare-and-set and emits the
 * same event naming the version it replaces.
 */
export const STAFF_DOCUMENT_TYPES = ["REPORT", "CONSENT_FORM", "REFERRAL_LETTER", "DISCHARGE_SUMMARY", "ID_PROOF", "OTHER"] as const;

/** Every type code a clinical document can carry: staff types and the generated ones (as clinicalDocumentFieldsFor stores them). */
export const CLINICAL_DOCUMENT_TYPE_CODES = [...new Set([...STAFF_DOCUMENT_TYPES, ...DOCUMENT_TYPES.map((t) => t.toUpperCase().replace(/-/g, "_"))])];

/** A stored type outside the closed set (rows older than it) is reported as OTHER, never as its text. */
const typeCode = (type: string) => ((CLINICAL_DOCUMENT_TYPE_CODES as string[]).includes(type) ? type : "OTHER");

async function emitRecorded(tx: Prisma.TransactionClient, doc: ClinicalDocument, byUserId: string) {
  await emitFacilityEvent(tx, {
    type: "ClinicalDocumentRecorded", aggregateId: doc.id, facilityId: doc.facilityId, encounterId: doc.encounterId, actorUserId: byUserId,
    payload: {
      documentId: doc.id, patientId: doc.patientId, ...(doc.encounterId ? { encounterId: doc.encounterId } : {}),
      documentType: typeCode(doc.type), accessPolicy: doc.accessPolicy, version: doc.version,
      ...(doc.supersedesId ? { supersedesDocumentId: doc.supersedesId } : {}),
    },
  });
}

export async function recordStaffDocument(input: {
  facilityId: string; patientId: string; encounterId?: string | null; type: string; title: string;
  accessPolicy?: string | null; storageRef?: string | null; staffId: string; byUserId: string;
}) {
  if (!(STAFF_DOCUMENT_TYPES as readonly string[]).includes(input.type)) throw new BadRequestError(`Unknown document type: use one of ${STAFF_DOCUMENT_TYPES.join(", ")}.`);
  const accessPolicy = input.accessPolicy ? parseEnum($Enums.ClinicalDocumentAccessPolicy, input.accessPolicy, "accessPolicy") : "CLINICAL_STAFF";
  return prisma.$transaction(async (tx) => {
    const doc = await tx.clinicalDocument.create({
      data: {
        facilityId: input.facilityId, patientId: input.patientId, encounterId: input.encounterId ?? null, type: input.type, title: input.title,
        storageRef: input.storageRef ?? null, accessPolicy, authorStaffId: input.staffId, uploadedByStaffId: input.staffId,
      },
    });
    await emitRecorded(tx, doc, input.byUserId);
    return doc;
  });
}

export async function versionStaffDocument(input: {
  documentId: string; facilityId: string; title?: string | null; storageRef?: string | null; accessPolicy?: string | null; staffId: string; byUserId: string;
}) {
  const accessPolicy = input.accessPolicy ? parseEnum($Enums.ClinicalDocumentAccessPolicy, input.accessPolicy, "accessPolicy") : undefined;
  return prisma.$transaction(async (tx) => {
    const prior = await tx.clinicalDocument.findUnique({ where: { id: input.documentId } });
    if (!prior || prior.facilityId !== input.facilityId) throw new NotFoundError("Document not found.");
    // Phase 0: a patient's upload belongs to their Person; staff never version it.
    if (prior.personId) throw new NotFoundError("Document not found.");
    if (prior.status !== "CURRENT") throw new BadRequestError("Only the current version of a document can be superseded.");
    const cas = await tx.clinicalDocument.updateMany({ where: { id: prior.id, status: "CURRENT" }, data: { status: "SUPERSEDED" } });
    if (cas.count !== 1) throw new BadRequestError("Document was updated by someone else — refresh and try again.");
    const doc = await tx.clinicalDocument.create({
      data: {
        facilityId: prior.facilityId, patientId: prior.patientId, encounterId: prior.encounterId, type: prior.type,
        title: input.title ?? prior.title, storageRef: input.storageRef ?? prior.storageRef, version: prior.version + 1, supersedesId: prior.id,
        status: "CURRENT", accessPolicy: accessPolicy ?? prior.accessPolicy, authorStaffId: input.staffId, uploadedByStaffId: input.staffId,
      },
    });
    await emitRecorded(tx, doc, input.byUserId);
    return doc;
  });
}
