import { NextRequest } from "next/server";
import { requireSession, withApiErrors } from "@/lib/auth/rbac";
import { listInteractions } from "@/lib/rag/interactions";

/** Week 4b — AI interaction metadata for the platform reviewers (never text). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    const sp = new URL(req.url).searchParams;
    return { interactions: await listInteractions({ role: session.role }, { since: sp.get("since") ? new Date(sp.get("since")!) : undefined, outcome: sp.get("outcome") ?? undefined }) };
  });
}
