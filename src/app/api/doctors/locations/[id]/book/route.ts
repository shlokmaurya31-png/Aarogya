import { NextRequest } from "next/server";
import { ForbiddenError, requireSession, withApiErrors } from "@/lib/auth/rbac";
import { bookThroughDirectory } from "@/lib/doctors/booking";

/** POST { start, mode?, reason?, share?: null | { categories?, sensitiveCategories?, period? } } — the patient books (Week 5a). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const session = await requireSession();
    if (session.role !== "PATIENT") throw new ForbiddenError("patient:self:manage");
    const body = await req.json().catch(() => ({}));
    return bookThroughDirectory(session.userId, { ...body, locationId: (await params).id });
  });
}
