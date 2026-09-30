/**
 * Phase 1.2 — public authenticity projection.
 *
 * /verify/<token> must prove a document is genuine WITHOUT disclosing any PHI.
 * The only facts returned are: that the token matches a real generated document,
 * its (generic) title/type, the issuing facility, the document number, the issue
 * date and whether it was a draft. Never the patient, never the clinical content.
 */
import { prisma } from "@/lib/db";

export interface PublicVerification {
  valid: boolean;
  documentType?: string;
  title?: string;
  facilityName?: string;
  documentNumber?: string;
  issuedOn?: string;
  isDraft?: boolean;
}

export interface VerifiableRow {
  type: string;
  title: string;
  documentNumber: string;
  isDraft: boolean;
  createdAt: Date;
}

/** Pure projection — no PHI ever leaves this function. Unit-tested directly. */
export function toPublicVerification(row: VerifiableRow | null, facilityName: string | undefined): PublicVerification {
  if (!row) return { valid: false };
  return {
    valid: true,
    documentType: row.type,
    title: row.title,
    facilityName,
    documentNumber: row.documentNumber,
    issuedOn: row.createdAt.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }),
    isDraft: row.isDraft,
  };
}

export async function verifyDocumentByToken(token: string): Promise<PublicVerification> {
  if (!token) return { valid: false };
  const row = await prisma.generatedDocument.findUnique({
    where: { verifyToken: token },
    select: {
      type: true, title: true, documentNumber: true, isDraft: true, createdAt: true,
      facility: { select: { name: true } },
    },
  });
  if (!row) return { valid: false };
  return toPublicVerification(row, row.facility?.name);
}
