import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { lookupSpecimen, setSpecimenIdentity } from "@/lib/hospital/diagnosticsAdvanced";

/** GET ?code=<barcode|accession> — facility-scoped specimen lookup (a barcode is never sufficient authorization on its own). */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("lab:specimen:collect", searchParams.get("facilityId") ?? undefined);
    const code = searchParams.get("code");
    if (!code) throw new BadRequestError("code (barcode or accession) is required.");
    return { specimen: await lookupSpecimen(facilityId, code) };
  });
}

/** POST — assign/refresh a specimen's barcode + container type. */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("lab:specimen:collect", body?.facilityId);
    if (!body?.specimenId) throw new BadRequestError("specimenId is required.");
    const specimen = await setSpecimenIdentity({ specimenId: body.specimenId, facilityId, barcode: body.barcode, containerType: body.containerType, byUserId: session.userId });
    return { specimen };
  });
}
