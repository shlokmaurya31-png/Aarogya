import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import { BadRequestError } from "@/lib/auth/rbac";
import { getStorageAdapter } from "@/lib/storage";
import type { PatientAccessScope } from "../context";
import { ownedPersonId } from "@/lib/person/access";
import { uploadPersonDocument } from "@/lib/person/documents";

/**
 * A patient uploads a document (an outside report, a referral letter, an ID)
 * to their own record. Stored through the storage adapter in the private
 * `patient-uploads` bucket (same checks as verification uploads: PDF / JPEG /
 * PNG / WebP, content must match the declared type, 15 MB), then recorded as
 * a PATIENT_VISIBLE ClinicalDocument uploaded by the patient's account. That
 * makes it visible in the patient portal (reports) and to the patient's care
 * team in the same facility (GET /api/hospital/documents), and nowhere else.
 */

export const PATIENT_DOCUMENT_TYPES = ["REPORT", "REFERRAL_LETTER", "ID_PROOF", "OTHER"] as const;
export type PatientDocumentType = (typeof PATIENT_DOCUMENT_TYPES)[number];

export async function uploadPatientDocument(
  scope: PatientAccessScope,
  actorUserId: string,
  input: { bytes: Buffer; contentType: string; originalName: string; title: string; type: PatientDocumentType }
) {
  // Self only: a delegate is read-only (resolveActScope already enforces it).
  if (!scope.isSelf) throw new BadRequestError("Only the patient can upload to their record.");
  // Phase 0: the upload belongs to the uploader's Person (PersonDocument, tied
  // to no facility); staff see it only through personAccess(). An account the
  // identity migration hasn't moved yet keeps the old facility path below.
  const ownerPersonId = await ownedPersonId(actorUserId);
  if (ownerPersonId) {
    const d = await uploadPersonDocument(actorUserId, input);
    return { id: d.id, title: d.title, type: d.type, sha256: d.sha256, createdAt: d.uploadedAt.toISOString() };
  }

  const title = input.title.trim().slice(0, 200);
  if (!title) throw new BadRequestError("A title is required.");

  const storage = getStorageAdapter();
  const stored = await storage.put({
    bucket: "patient-uploads",
    bytes: input.bytes,
    contentType: input.contentType,
    originalName: input.originalName,
    scope: scope.patientId,
  });


  let doc;
  try {
    doc = await prisma.$transaction(async (tx) => {
      const created = await tx.clinicalDocument.create({
        data: {
          facilityId: scope.facilityId,
          patientId: scope.patientId,
          type: input.type,
          title,
          storageRef: stored.storageRef,
          sha256: stored.sha256,
          accessPolicy: "PATIENT_VISIBLE",
          uploadedByUserId: actorUserId,
          personId: ownerPersonId,
        },
      });
      // In the insert's transaction; the object was stored first, and a rolled-back
      // insert deletes it below (design §1.2 #55).
      await emitFacilityEvent(tx, {
        type: "PatientDocumentUploaded", aggregateId: created.id, facilityId: scope.facilityId, actorUserId, personId: ownerPersonId,
        payload: { documentId: created.id, patientId: scope.patientId, documentType: input.type, uploadedBy: "PATIENT" },
      });
      return created;
    });
  } catch (err) {
    // Don't leave an orphaned object behind a failed record.
    await storage.delete(stored.storageRef).catch(() => undefined);
    throw err;
  }

  await recordAuditEvent(
    "patient.document.uploaded",
    actorUserId,
    { documentId: doc.id, type: input.type, sha256: stored.sha256, size: stored.size, contentType: stored.contentType },
    { facilityId: scope.facilityId, patientId: scope.patientId }
  );
  return { id: doc.id, title: doc.title, type: doc.type, sha256: stored.sha256, createdAt: doc.createdAt.toISOString() };
}
