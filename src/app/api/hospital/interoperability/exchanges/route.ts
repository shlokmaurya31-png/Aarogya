import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { createExchange, listExchanges } from "@/lib/hospital/interoperability/exchange";

export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("interop:exchange:read", searchParams.get("facilityId") ?? undefined);
    const exchanges = await listExchanges({
      facilityId,
      status: searchParams.get("status") ?? undefined,
      patientId: searchParams.get("patientId") ?? undefined,
    });
    return { exchanges };
  });
}

/**
 * Create an exchange intent. Consent/purpose/scope authorization is evaluated
 * inside createExchange, so an unauthorized intent is never persisted. The
 * response reports `deduplicated` when an idempotent retry resolved to an
 * existing exchange rather than creating a second transfer.
 */
export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("interop:exchange:request", body?.facilityId);
    if (!body?.direction || !body?.purpose || !body?.destinationSystem) {
      throw new BadRequestError("direction, purpose and destinationSystem are required.");
    }
    const { exchange, deduplicated } = await createExchange({
      facilityId,
      patientId: body.patientId ?? null,
      direction: body.direction,
      purpose: body.purpose,
      scopes: Array.isArray(body.scopes) ? body.scopes : [],
      destinationSystem: body.destinationSystem,
      destinationEndpoint: body.destinationEndpoint ?? null,
      consentId: body.consentId ?? null,
      recipientIdentifier: body.recipientIdentifier ?? null,
      correlationId: body.correlationId ?? null,
      idempotencyKey: req.headers.get("idempotency-key") ?? body.idempotencyKey ?? null,
      requestedByStaffId: staff?.id ?? null,
      byUserId: session.userId,
    });
    return { exchange, deduplicated };
  });
}
