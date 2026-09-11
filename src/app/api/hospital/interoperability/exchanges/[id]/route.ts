import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import {
  getExchange, authorizeExchange, rejectExchange, cancelExchange, dispatchExchange, retryExchange,
} from "@/lib/hospital/interoperability/exchange";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("interop:exchange:read", searchParams.get("facilityId") ?? undefined);
    const exchange = await getExchange(facilityId, id);
    return { exchange };
  });
}

/**
 * Exchange lifecycle.
 *
 * Authorising, dispatching and retrying all require interop:exchange:authorize,
 * which DOCTOR does not hold — so the clinician who requested a transfer cannot
 * also approve and send it. Rejection and cancellation are separated from
 * authorisation for the same reason.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const action = body?.action;

    switch (action) {
      case "authorize": {
        const { session, facilityId, staff } = await requireFacilityStaff("interop:exchange:authorize", body?.facilityId);
        const exchange = await authorizeExchange({
          facilityId, exchangeId: id, authorizedByStaffId: staff?.id, byUserId: session.userId,
        });
        return { exchange };
      }
      case "reject": {
        const { session, facilityId } = await requireFacilityStaff("interop:exchange:authorize", body?.facilityId);
        if (!body?.reason) throw new BadRequestError("A rejection reason is required.");
        const exchange = await rejectExchange({ facilityId, exchangeId: id, reason: body.reason, byUserId: session.userId });
        return { exchange };
      }
      case "cancel": {
        const { session, facilityId } = await requireFacilityStaff("interop:exchange:request", body?.facilityId);
        const exchange = await cancelExchange({ facilityId, exchangeId: id, reason: body?.reason, byUserId: session.userId });
        return { exchange };
      }
      case "dispatch": {
        const { session, facilityId, staff } = await requireFacilityStaff("interop:exchange:authorize", body?.facilityId);
        const exchange = await dispatchExchange({
          facilityId, exchangeId: id, byUserId: session.userId, actorStaffId: staff?.id ?? null,
        });
        return { exchange };
      }
      case "retry": {
        const { session, facilityId, staff } = await requireFacilityStaff("interop:exchange:authorize", body?.facilityId);
        const exchange = await retryExchange({
          facilityId, exchangeId: id, byUserId: session.userId, actorStaffId: staff?.id ?? null,
        });
        return { exchange };
      }
      default:
        throw new BadRequestError("action must be authorize, reject, cancel, dispatch or retry.");
    }
  });
}
