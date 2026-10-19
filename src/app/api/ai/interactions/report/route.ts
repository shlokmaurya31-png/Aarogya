import { NextRequest } from "next/server";
import { requireSession, withApiErrors } from "@/lib/auth/rbac";
import { monthlyReviewReport } from "@/lib/rag/interactions";

/** Week 4b — the monthly review report: every reviewer read, and the month's outcomes by mode. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const session = await requireSession();
    return monthlyReviewReport({ role: session.role }, new URL(req.url).searchParams.get("month") ?? "");
  });
}
