import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { patientSession } from "@/lib/household/routeAuth";
import { requestReprocess } from "@/lib/documents/patientView";

/** POST { reason } — process a member's upload again, as their proxy (UPLOAD), e.g. once a guardian has given consent (Week 5b). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ personId: string; documentId: string }> }) {
  return withApiErrors(async () => {
    const s = await patientSession();
    const { personId, documentId } = await params;
    const b = (await req.json().catch(() => null)) as { reason?: unknown } | null;
    return requestReprocess(s.userId, documentId, b?.reason ?? "PATIENT_REQUEST", personId);
  });
}
