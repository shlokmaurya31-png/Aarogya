import { NextRequest } from "next/server";
import { withApiErrors } from "@/lib/auth/rbac";
import { parseSearch, searchDirectory } from "@/lib/doctors/directory";

/**
 * GET — the public doctor directory (Week 5a): verified, listed doctors only,
 * public fields only. ?specialty= &symptom= &language= &mode= &maxFee=(₹)
 * &lat= &lng= &km= &slotWithinDays=. The point is used for this query only
 * and never stored; no login is needed and none is read.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => searchDirectory(parseSearch(req.nextUrl.searchParams)));
}
