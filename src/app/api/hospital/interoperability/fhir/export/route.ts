import { NextRequest, NextResponse } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { exportPatientToFhir } from "@/lib/hospital/interoperability/fhir/export";

/**
 * Phase C1 — controlled FHIR export.
 *
 * Deliberately POST, not GET. An export is an authorization decision that names
 * a purpose, a scope and a consent — it is not a readable resource, and it must
 * never be reachable by pasting a patient id into a URL, or be cached by a proxy
 * or sat in browser history.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("interop:fhir:export", body?.facilityId);

    if (!body?.patientId) throw new BadRequestError("patientId is required.");
    if (!body?.purpose) throw new BadRequestError("purpose is required.");
    if (!Array.isArray(body?.scopes) || body.scopes.length === 0) {
      throw new BadRequestError("At least one data scope is required.");
    }

    const result = await exportPatientToFhir({
      facilityId,
      patientId: body.patientId,
      purpose: body.purpose,
      scopes: body.scopes,
      consentId: body.consentId ?? null,
      recipientIdentifier: body.recipientIdentifier ?? null,
      encounterId: body.encounterId ?? null,
      bundleType: body.bundleType,
      correlationId: body.correlationId ?? null,
      actorStaffId: staff?.id ?? null,
      byUserId: session.userId,
    });

    return {
      bundle: result.bundle,
      bundleHash: result.bundleHash,
      resourceCount: result.resourceCount,
      scopes: result.scopes,
      basis: result.basis,
      consentId: result.consentId,
    };
  });
}

/**
 * An export must never be a plain GET; answer explicitly rather than 404 so the
 * constraint is discoverable.
 */
export async function GET() {
  return NextResponse.json(
    { error: "Export is a POST operation: it requires a purpose, data scopes and a consent reference." },
    { status: 405 }
  );
}
