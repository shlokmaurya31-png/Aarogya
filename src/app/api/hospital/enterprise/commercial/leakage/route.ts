import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requireActorMemberships } from "@/lib/auth/tenantContext";
import { runLeakageDetection } from "@/lib/commercial/analytics/leakage";
import { listExceptions } from "@/lib/commercial/analytics/reconciliationIntel";

/** GET: platform-only list of open LEAKAGE findings. */
export async function GET() {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    return { findings: await listExceptions(m, { source: "LEAKAGE", resolved: false }) };
  });
}

/** POST: platform-only — run the deterministic leakage detector (detection only, never corrects). */
export async function POST(_req: NextRequest) {
  return withApiErrors(async () => {
    const m = await requireActorMemberships("commercial:platform:manage");
    return runLeakageDetection(m);
  });
}
