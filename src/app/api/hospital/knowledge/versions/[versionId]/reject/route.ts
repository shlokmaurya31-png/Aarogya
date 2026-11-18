import { NextRequest } from "next/server";
import { knowledgeApi } from "@/lib/knowledge/errors";
import { requireKnowledgeActor } from "@/lib/knowledge/actor";
import { rejectKnowledgeVersion } from "@/lib/knowledge/service";

/** RAG Phase 2 — POST { reason }: reject a version waiting for approval (the reason is audited). Another facility's or organisation's version is a 404. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  return knowledgeApi(async () => {
    const actor = await requireKnowledgeActor("approve", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    const { versionId } = await params;
    const b = await req.json().catch(() => ({}));
    return rejectKnowledgeVersion(actor, versionId, String(b?.reason ?? ""));
  });
}
