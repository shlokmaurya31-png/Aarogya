import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { guardianConsents, startGuardianConsent } from "@/lib/household/guardianConsent";

/** GET — a managed child's processing and AI choices, for their guardian (Week 5b). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ personId: string }> }) {
  return withApiErrors(async () => guardianConsents((await patientSession()).userId, (await params).personId));
}

/** POST { purpose, decision, scopes?, relationship, declaration: true } — starts the parental-consent check; a code goes to your phone. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ personId: string }> }) {
  return withApiErrors(async () => {
    const s = await patientSession();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return startGuardianConsent(s.userId, (await params).personId, body);
  });
}
