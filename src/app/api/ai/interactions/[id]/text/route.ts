import { NextRequest } from "next/server";
import { requireSession, withApiErrors } from "@/lib/auth/rbac";
import { readInteractionText } from "@/lib/rag/interactions";

/** Week 4b — a reviewer reads retained AI text: { reasonCode, ticketRef }; logged and audited (docs/RAG_DESIGN.md §4.3). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const session = await requireSession();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    return readInteractionText({ interactionId: id, reader: { userId: session.userId, role: session.role }, reasonCode: String(body?.reasonCode ?? ""), ticketRef: String(body?.ticketRef ?? "") });
  });
}
