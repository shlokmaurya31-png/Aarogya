import { NextRequest } from "next/server";
import { knowledgeApi } from "@/lib/knowledge/errors";
import { dateField, requireKnowledgeActor } from "@/lib/knowledge/actor";
import { reproposeKnowledgeVersion } from "@/lib/knowledge/service";

/**
 * Plan §13.4 B — POST { effectiveAt?, expiresAt? }: propose an older version
 * (in force once, not now) again, as the next version number. It needs the
 * same two-person approval as an upload; the proposer can't approve it.
 * Hospital administrator. Another facility's or organisation's version is a 404.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ versionId: string }> }) {
  return knowledgeApi(async () => {
    const actor = await requireKnowledgeActor("manage", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    const { versionId } = await params;
    const b = await req.json().catch(() => ({}));
    const r = await reproposeKnowledgeVersion(actor, versionId, { effectiveAt: dateField(b?.effectiveAt), expiresAt: dateField(b?.expiresAt) });
    return { document: { id: r.documentId }, version: { id: r.versionId, version: r.version, state: "PROCESSING" } };
  });
}
