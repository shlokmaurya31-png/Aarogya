import { NextRequest } from "next/server";
import { requirePermission, withApiErrors } from "@/lib/auth/rbac";
import { aiUsageReport } from "@/lib/rag/usage";

/**
 * RAG Phase 4, step 4.5 — AI usage for an organisation's or a facility's
 * administrator: tokens, cost estimate, cache hits and latency, by facility,
 * role, module, model or request type (and by user for the facility's own
 * administrator). Metadata only; no patient data.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requirePermission("ai:usage:read");
    const p = new URL(req.url).searchParams;
    return aiUsageReport({ userId: session.userId, role: session.role }, {
      organizationId: p.get("organizationId"), facilityId: p.get("facilityId"), from: p.get("from"), to: p.get("to"), groupBy: p.get("groupBy"),
    });
  });
}
