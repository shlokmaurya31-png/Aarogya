import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { requirePatientContext, resolveReadScope } from "@/lib/patient/context";
import { listQueuePositions } from "@/lib/patient/experience/queue";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const ctx = await requirePatientContext();
    const { searchParams } = new URL(req.url);
    const scope = await resolveReadScope(ctx, searchParams.get("patientId"));
    return { positions: await listQueuePositions(scope) };
  });
}
