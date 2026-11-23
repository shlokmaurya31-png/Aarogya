import { NextRequest } from "next/server";
import { knowledgeApi } from "@/lib/knowledge/errors";
import { requireKnowledgeActor } from "@/lib/knowledge/actor";
import { removeFacilityContact } from "@/lib/knowledge/contacts";

/** Plan §13.4 C — DELETE: the number leaves the facility's published list (the row is kept, with who removed it; audited). Another facility's number is a 404. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ contactId: string }> }) {
  return knowledgeApi(async () => {
    const actor = await requireKnowledgeActor("manage", req.nextUrl.searchParams.get("facilityId") ?? undefined);
    const { contactId } = await params;
    return removeFacilityContact(actor, contactId);
  });
}
