import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { linkExternalIdentifier, listExternalIdentifiers } from "@/lib/hospital/interoperability/externalIdentity";

/**
 * Phase C1 — external registry identifier mappings (ABHA / HFR / HPR).
 *
 * facilityId always comes from requireFacilityStaff, which reads the caller's
 * staff profile from the database. A facilityId in the body is only ever used as
 * the AAROGYA_ADMIN facility selector that requireFacilityStaff itself validates
 * — it can never widen a normal user's scope.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff(
      "interop:identifier:read",
      searchParams.get("facilityId") ?? undefined
    );
    const identifiers = await listExternalIdentifiers({
      facilityId,
      entityType: searchParams.get("entityType") ?? undefined,
      entityId: searchParams.get("entityId") ?? undefined,
      system: searchParams.get("system") ?? undefined,
    });
    return { identifiers };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("interop:identifier:manage", body?.facilityId);
    if (!body?.entityType || !body?.entityId || !body?.system || !body?.value) {
      throw new BadRequestError("entityType, entityId, system and value are required.");
    }
    const identifier = await linkExternalIdentifier({
      facilityId,
      entityType: body.entityType,
      entityId: body.entityId,
      system: body.system,
      value: body.value,
      use: body.use,
      source: body.source,
      periodStart: body.periodStart ? new Date(body.periodStart) : undefined,
      periodEnd: body.periodEnd ? new Date(body.periodEnd) : undefined,
      // The acting staff member is derived from the session, never from the body.
      createdByStaffId: staff?.id,
      byUserId: session.userId,
    });
    return { identifier };
  });
}
