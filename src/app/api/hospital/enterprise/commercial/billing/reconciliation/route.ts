import { NextRequest } from "next/server";
import { z } from "zod";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { runReconciliation, listReconciliationExceptions, resolveException } from "@/lib/billing/reconciliation";

/** Platform-only: list open reconciliation exceptions. */
export async function GET() {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    return { exceptions: await listReconciliationExceptions(m) };
  });
}

const schema = z.union([
  z.object({ action: z.literal("run"), organizationId: z.string().optional() }),
  z.object({ action: z.literal("resolve"), id: z.string().min(1) }),
]);

/** Platform-only: run a reconciliation scan, or resolve an exception. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new BadRequestError("Invalid input.");
    if (parsed.data.action === "run") return runReconciliation(m, parsed.data.organizationId);
    return { exception: await resolveException(m, parsed.data.id) };
  });
}
