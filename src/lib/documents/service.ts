/**
 * Phase 1.2 — document generation service.
 *
 * Composes template → PDF bytes → object storage → GeneratedDocument +
 * ClinicalDocument rows (one transaction) → audit. Every generated document is
 * recorded with its sha256 and an unguessable public verifyToken (the QR
 * target). D4: the ClinicalDocument is the document in the patient's record
 * (portal, Hospital OS document list); GeneratedDocument keeps the render,
 * hash and verify-token metadata. Facility-scoped; audited via
 * recordAuditEvent.
 */
import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { getStorageAdapter } from "@/lib/storage";
import { recordAuditEvent } from "@/lib/auth/audit";
import { NotFoundError } from "@/lib/auth/rbac";
import { buildDocumentSpec, documentTitle, type DocumentInput } from "./templates";
import { renderDocument, type Letterhead } from "./pdf/layout";

export function newVerifyToken(): string {
  return randomBytes(24).toString("base64url");
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
}

export function verifyUrlFor(token: string): string {
  return `${appBaseUrl()}/verify/${token}`;
}

const DOC_PREFIX: Record<DocumentInput["type"], string> = {
  prescription: "RX",
  "opd-summary": "OPD",
  "discharge-summary": "DS",
  "lab-report": "LAB",
  "radiology-report": "RAD",
  invoice: "INV",
  "refund-note": "RFD",
  "claim-packet": "CLM",
  certificate: "CRT",
  "referral-letter": "REF",
  "death-certificate": "DTH",
  "birth-record": "BTH",
};

/**
 * The ClinicalDocument type, status and visibility of a generated document.
 * Must match the backfill in migration 20261014200000_generated_document_is_clinical.
 * A draft is kept out of every default list; a claim packet is for staff only.
 */
export function clinicalDocumentFieldsFor(type: DocumentInput["type"], isDraft: boolean) {
  return {
    type: type.toUpperCase().replace(/-/g, "_"),
    status: isDraft ? "DRAFT" : "CURRENT",
    accessPolicy: type === "claim-packet" ? "CLINICAL_STAFF" : "PATIENT_VISIBLE",
  };
}

export function defaultDocumentNumber(type: DocumentInput["type"], at = new Date()): string {
  const ymd = `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, "0")}${String(at.getDate()).padStart(2, "0")}`;
  return `${DOC_PREFIX[type]}-${ymd}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

export interface GenerateDocumentCtx {
  facilityId: string;
  letterhead: Letterhead;
  issuedByUserId?: string | null;
  /** Every generated document belongs to a patient's record. */
  patientId: string;
  encounterId?: string | null;
  documentNumber?: string;
  isDraft?: boolean;
}

export interface GeneratedDocumentResult {
  id: string;
  clinicalDocumentId: string;
  verifyToken: string;
  storageRef: string;
  sha256: string;
  documentNumber: string;
  /** A short-lived signed URL to download the freshly generated PDF. */
  downloadUrl: string;
}

export async function generateAndStoreDocument(
  input: DocumentInput,
  ctx: GenerateDocumentCtx
): Promise<GeneratedDocumentResult> {
  // Checked before anything is rendered or stored, so a refusal leaves no file behind.
  const patient = await prisma.patient.findUnique({ where: { id: ctx.patientId }, select: { facilityId: true } });
  if (!patient || patient.facilityId !== ctx.facilityId) throw new NotFoundError("Patient not found.");
  const verifyToken = newVerifyToken();
  const documentNumber = ctx.documentNumber ?? defaultDocumentNumber(input.type);

  const spec = buildDocumentSpec(input, {
    letterhead: ctx.letterhead,
    documentNumber,
    issuedOn: new Date().toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }),
    verifyUrl: verifyUrlFor(verifyToken),
    isDraft: ctx.isDraft,
  });

  const bytes = Buffer.from(await renderDocument(spec));
  const storage = getStorageAdapter();
  const stored = await storage.put({
    bucket: "generated-pdf",
    bytes,
    contentType: "application/pdf",
    originalName: `${input.type}-${documentNumber}.pdf`,
    scope: ctx.facilityId,
  });

  const author = ctx.issuedByUserId
    ? await prisma.hospitalStaffProfile.findUnique({ where: { userId: ctx.issuedByUserId }, select: { id: true } })
    : null;
  const title = documentTitle(input);

  const { row, clinical } = await prisma.$transaction(async (tx) => {
    const row = await tx.generatedDocument.create({
      data: {
        facilityId: ctx.facilityId,
        type: input.type,
        title,
        documentNumber,
        storageRef: stored.storageRef,
        sha256: stored.sha256,
        verifyToken,
        issuedByName: ctx.letterhead.authorName,
        authorRegistration: ctx.letterhead.authorRegistration,
        isDraft: ctx.isDraft ?? false,
      },
    });
    const clinical = await tx.clinicalDocument.create({
      data: {
        facilityId: ctx.facilityId,
        patientId: ctx.patientId,
        encounterId: ctx.encounterId ?? undefined,
        title,
        storageRef: stored.storageRef,
        sha256: stored.sha256,
        authorStaffId: author?.id,
        generatedDocumentId: row.id,
        ...clinicalDocumentFieldsFor(input.type, ctx.isDraft ?? false),
      },
    });
    return { row, clinical };
  });

  await recordAuditEvent(
    "hospital.document.created",
    ctx.issuedByUserId ?? null,
    { documentType: input.type, documentNumber, generatedDocumentId: row.id, clinicalDocumentId: clinical.id, sha256: stored.sha256, isDraft: ctx.isDraft ?? false },
    { facilityId: ctx.facilityId, patientId: ctx.patientId }
  );

  const { url } = await storage.signedDownloadUrl(stored.storageRef);
  return { id: row.id, clinicalDocumentId: clinical.id, verifyToken, storageRef: stored.storageRef, sha256: stored.sha256, documentNumber, downloadUrl: url };
}
