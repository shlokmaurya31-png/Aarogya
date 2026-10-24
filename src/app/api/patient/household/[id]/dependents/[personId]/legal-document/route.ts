import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { submitLegalDocument } from "@/lib/household/dependentConsent";

/** POST { documentId, kind } — put a legal document (uploaded to their profile) up for a staff member's review (Week 5b). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; personId: string }> }) {
  return withApiErrors(async () => {
    const { id, personId } = await params;
    const b = await req.json().catch(() => ({}));
    return submitLegalDocument((await patientSession()).userId, id, personId, String(b?.documentId ?? ""), b?.kind);
  });
}
