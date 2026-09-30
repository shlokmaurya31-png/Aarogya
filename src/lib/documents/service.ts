/**
 * Phase 1.2 — document generation service.
 *
 * Composes template → PDF bytes → object storage → GeneratedDocument row →
 * audit. Every generated document is recorded with its sha256 and an unguessable
 * public verifyToken (the QR target). Facility-scoped; the PHI-read/write is
 * audited via recordAuditEvent.
 */
import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { getStorageAdapter } from "@/lib/storage";
import { recordAuditEvent } from "@/lib/auth/audit";
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

export function defaultDocumentNumber(type: DocumentInput["type"], at = new Date()): string {
  const ymd = `${at.getFullYear()}${String(at.getMonth() + 1).padStart(2, "0")}${String(at.getDate()).padStart(2, "0")}`;
  return `${DOC_PREFIX[type]}-${ymd}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

export interface GenerateDocumentCtx {
  facilityId: string;
  letterhead: Letterhead;
  issuedByUserId?: string | null;
  patientId?: string | null;
  documentNumber?: string;
  isDraft?: boolean;
}

export interface GeneratedDocumentResult {
  id: string;
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

  const row = await prisma.generatedDocument.create({
    data: {
      facilityId: ctx.facilityId,
      type: input.type,
      title: documentTitle(input),
      documentNumber,
      storageRef: stored.storageRef,
      sha256: stored.sha256,
      verifyToken,
      issuedByUserId: ctx.issuedByUserId ?? undefined,
      issuedByName: ctx.letterhead.authorName,
      authorRegistration: ctx.letterhead.authorRegistration,
      patientId: ctx.patientId ?? undefined,
      isDraft: ctx.isDraft ?? false,
    },
  });

  await recordAuditEvent(
    "hospital.document.created",
    ctx.issuedByUserId ?? null,
    { documentType: input.type, documentNumber, generatedDocumentId: row.id, sha256: stored.sha256, isDraft: ctx.isDraft ?? false },
    { facilityId: ctx.facilityId, patientId: ctx.patientId ?? undefined }
  );

  const { url } = await storage.signedDownloadUrl(stored.storageRef);
  return { id: row.id, verifyToken, storageRef: stored.storageRef, sha256: stored.sha256, documentNumber, downloadUrl: url };
}
