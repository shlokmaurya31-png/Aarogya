import { NextRequest } from "next/server";
import { requireVerifiedStudent } from "@/lib/auth/currentStudent";
import { getActiveCaseProvider } from "@/lib/clinical/gateway";
import { withApiErrors } from "@/lib/auth/rbac";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    await requireVerifiedStudent("student:case:view");
    const { searchParams } = new URL(req.url);
    const provider = getActiveCaseProvider();
    const cases = await provider.listCases({
      specialty: searchParams.get("specialty") ?? undefined,
      difficulty: searchParams.get("difficulty") ?? undefined,
      acuity: searchParams.get("acuity") ?? undefined,
      learnerTrack: searchParams.get("learnerTrack") ?? undefined,
      query: searchParams.get("q") ?? undefined,
    });
    return { cases };
  });
}
