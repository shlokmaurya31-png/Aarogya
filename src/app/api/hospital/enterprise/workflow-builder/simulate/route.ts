import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { recordAuditEvent } from "@/lib/auth/audit";
import { assertCanReadWorkflowScope } from "@/lib/workflows/authz";
import { parseBuilderDocument, compileBuilderDocument, simulateWorkflow } from "@/lib/workflow-builder";

/**
 * POST: side-effect-free simulation of a builder document against a SYNTHETIC event.
 * Creates nothing, emits nothing — it only reads configuration. Tenant scope for SLA
 * resolution is authorized from the caller's membership (never client-authoritative).
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("workflow:read");
    const body = await req.json().catch(() => ({}));
    const organizationId: string | undefined = body?.organizationId ?? undefined;
    if (organizationId) assertCanReadWorkflowScope(m, organizationId);
    const doc = parseBuilderDocument(body?.document);
    const config = compileBuilderDocument(doc); // must be publishable-valid to simulate
    const result = await simulateWorkflow({
      config,
      synthetic: { payload: body?.payload ?? {}, organizationId: organizationId ?? null, facilityId: body?.facilityId ?? null },
      workflowKey: typeof body?.key === "string" ? body.key : undefined,
    });
    await recordAuditEvent("workflow.builder.simulated", m.userId, { key: body?.key ?? null, triggerMatched: result.triggerMatched }, { organizationId });
    if (!result) throw new BadRequestError("Simulation failed.");
    return result;
  });
}
