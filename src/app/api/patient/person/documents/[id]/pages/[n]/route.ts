import { NextRequest } from "next/server";
import { requireSession, withApiErrors, ForbiddenError } from "@/lib/auth/rbac";
import { pageView } from "@/lib/documents/patientView";

/** Week 4a: one page — the original image, the text as read and (only if it passed the exact-copy check) the translation. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; n: string }> }) {
  return withApiErrors(async () => {
    const { id, n } = await params;
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    return pageView(session.userId, id, Number(n));
  });
}
