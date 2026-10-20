import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { restoreGrant } from "@/lib/household/comingOfAge";

/** POST { permissions, categories?, sensitiveCategories? } — after claiming, give a former proxy access again, as you choose (Week 5b). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => restoreGrant((await patientSession()).userId, (await params).id, await req.json().catch(() => ({}))));
}
