import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { requestReprocess } from "@/lib/documents/patientView";

/** Week 4a: ask for a fresh run of a document. Body { reason: "PATIENT_REQUEST" | "LANGUAGE_CHANGED" }. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const b = await req.json().catch(() => null);
    return requestReprocess(session.userId, id, b?.reason);
  });
}
