import { NextRequest } from "next/server";
import { knowledgeApi } from "@/lib/knowledge/errors";
import { requireKnowledgeActor } from "@/lib/knowledge/actor";
import { addFacilityContact, listFacilityContacts } from "@/lib/knowledge/contacts";

/**
 * Plan §13.4 C — the facility's published contact numbers (switchboard,
 * helplines, ambulance), which its knowledge documents may print without a
 * highlight. GET: administrators and approvers. POST { kind, label, number }:
 * the hospital administrator; audited.
 */
export async function GET(req: NextRequest) {
  return knowledgeApi(async () => {
    const actor = await requireKnowledgeActor("read", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    return { contacts: await listFacilityContacts(actor) };
  });
}

export async function POST(req: NextRequest) {
  return knowledgeApi(async () => {
    const actor = await requireKnowledgeActor("manage", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    const b = await req.json().catch(() => ({}));
    return { contact: await addFacilityContact(actor, { kind: b?.kind, label: b?.label, number: b?.number }) };
  });
}
