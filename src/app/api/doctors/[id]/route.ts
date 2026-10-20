import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { publicProfile } from "@/lib/doctors/directory";

/** GET — one verified, listed doctor's public profile (Week 5a); anything else is a 404. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => publicProfile((await params).id));
}
