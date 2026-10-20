import { NextRequest } from "next/server";
import { requirePermission, withApiErrors } from "@/lib/auth/rbac";
import { caseDocumentUrl } from "@/lib/doctors/verification";

/** GET — a 5-minute URL for a case document, audited (Week 5a; doctor:verify). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; index: string }> }) {
  return withApiErrors(async () => {
    const s = await requirePermission("doctor:verify");
    const { id, index } = await params;
    return caseDocumentUrl({ userId: s.userId, verifier: true }, id, Number(index));
  });
}
