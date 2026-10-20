import { NextRequest } from "next/server";
import { BadRequestError, withApiErrors } from "@/lib/auth/rbac";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { legalDocumentUrl, reviewLegalDocument } from "@/lib/household/dependentConsent";

async function staffActor() {
  const { session, staff, facilityId } = await requireFacilityStaff("patient:read");
  if (!staff) throw new BadRequestError("A staff profile is required.");
  return { userId: session.userId, staffId: staff.id, facilityId };
}

/** GET — read the legal document under review (5-minute URL, audited) (Week 5b). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ consentId: string }> }) {
  return withApiErrors(async () => legalDocumentUrl(await staffActor(), (await params).consentId));
}
/** POST { accept: boolean } — accept or refuse it as the basis of a dependent adult's proxy. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ consentId: string }> }) {
  return withApiErrors(async () => reviewLegalDocument(await staffActor(), (await params).consentId, (await req.json().catch(() => ({})))?.accept === true));
}
