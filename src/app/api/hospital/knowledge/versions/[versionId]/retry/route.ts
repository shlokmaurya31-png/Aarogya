import { NextRequest } from "next/server";
import { knowledgeApi } from "@/lib/knowledge/errors";
import { requireKnowledgeActor } from "@/lib/knowledge/actor";
import { retryKnowledgeIngestion } from "@/lib/knowledge/service";

/** RAG Phase 2 — POST: queue a FAILED ingestion again. Another facility's or organisation's version is a 404. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  return knowledgeApi(async () => {
    const actor = await requireKnowledgeActor("manage", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    const { versionId } = await params;
    return retryKnowledgeIngestion(actor, versionId);
  });
}
