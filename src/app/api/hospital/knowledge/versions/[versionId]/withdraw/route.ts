import { NextRequest } from "next/server";
import { knowledgeApi } from "@/lib/knowledge/errors";
import { requireKnowledgeActor } from "@/lib/knowledge/actor";
import { withdrawKnowledgeVersion } from "@/lib/knowledge/service";

/** RAG Phase 2 — POST { reason }: take a version out of use; if it was in force, the document has none until another is published. Another facility's or organisation's version is a 404. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  return knowledgeApi(async () => {
    const actor = await requireKnowledgeActor("manage", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    const { versionId } = await params;
    const b = await req.json().catch(() => ({}));
    return withdrawKnowledgeVersion(actor, versionId, String(b?.reason ?? ""));
  });
}
