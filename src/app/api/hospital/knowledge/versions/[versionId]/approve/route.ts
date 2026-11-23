import { NextRequest } from "next/server";
import { knowledgeApi } from "@/lib/knowledge/errors";
import { dateField, requireKnowledgeActor } from "@/lib/knowledge/actor";
import { approveKnowledgeVersion } from "@/lib/knowledge/service";

/** RAG Phase 2 — POST { effectiveAt?, expiresAt?, acknowledgedHighlightIds? }: approve a version that is indexed and waiting; never by its uploader; every highlighted number acknowledged (plan §13.4 C). In force now: published at once. Another facility's or organisation's version is a 404. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  return knowledgeApi(async () => {
    const actor = await requireKnowledgeActor("approve", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    const { versionId } = await params;
    const b = await req.json().catch(() => ({}));
    return approveKnowledgeVersion(actor, versionId, { effectiveAt: dateField(b?.effectiveAt), expiresAt: dateField(b?.expiresAt), acknowledgedHighlightIds: Array.isArray(b?.acknowledgedHighlightIds) ? b.acknowledgedHighlightIds.filter((x: unknown): x is string => typeof x === "string") : [] });
  });
}
