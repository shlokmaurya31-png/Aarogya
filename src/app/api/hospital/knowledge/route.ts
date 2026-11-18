import { NextRequest } from "next/server";
import { BadRequestError } from "@/lib/auth/rbac";
import { roleHasPermission } from "@/lib/auth/permissions";
import { knowledgeApi } from "@/lib/knowledge/errors";
import { dateField, requireKnowledgeActor } from "@/lib/knowledge/actor";
import { listKnowledge, uploadKnowledge } from "@/lib/knowledge/service";

/**
 * RAG Phase 2 — knowledge documents (docs/RAG_IMPLEMENTATION_PLAN.md §4).
 * GET: this facility's and the organisation's documents with each version's
 * state (hospital administrator or approver); never a hash, a storage
 * reference or file contents.
 * POST (multipart): a file as a new document (title, documentType,
 * accessClass, scope) or as the next version of `documentId`; refused whole,
 * with nothing kept, if it looks like it names a patient. Hospital administrator.
 */
export async function GET(req: NextRequest) {
  return knowledgeApi(async () => {
    const actor = await requireKnowledgeActor("read", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    return { documents: await listKnowledge(actor), canManage: roleHasPermission(actor.role, "knowledge:manage"), canApprove: roleHasPermission(actor.role, "knowledge:approve"), orgAdmin: actor.orgAdmin };
  });
}

export async function POST(req: NextRequest) {
  return knowledgeApi(async () => {
    const form = await req.formData().catch(() => null);
    const actor = await requireKnowledgeActor("manage", (form?.get("facilityId") as string | null) ?? undefined);
    const file = form?.get("file");
    if (!file || typeof file !== "object" || !("arrayBuffer" in file)) throw new BadRequestError("Choose a file to upload.");
    const str = (k: string) => { const v = form!.get(k); return typeof v === "string" ? v : undefined; };
    const result = await uploadKnowledge(actor, {
      documentId: str("documentId") || undefined, title: str("title"), description: str("description") ?? null, documentType: str("documentType"),
      accessClass: str("accessClass"), scope: str("scope") === "ORGANIZATION" ? "ORGANIZATION" : "FACILITY", language: str("language") || undefined,
      effectiveAt: dateField(str("effectiveAt")) ?? null, expiresAt: dateField(str("expiresAt")) ?? null,
      fileName: (file as File).name, declaredType: (file as File).type, bytes: Buffer.from(await (file as File).arrayBuffer()),
    });
    return { document: { id: result.documentId }, version: { id: result.versionId, version: result.version, state: "PROCESSING" } };
  });
}
