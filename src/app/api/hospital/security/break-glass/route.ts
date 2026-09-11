import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { buildAuthorizationActor } from "@/lib/auth/authorize/context";
import { requireAuthorization } from "@/lib/auth/authorize/engine";
import {
  activateBreakGlass, listBreakGlass, completeBreakGlass, revokeBreakGlass,
  breakGlassAbuseReport, expireLapsedBreakGlass, EMERGENCY_CONTEXTS,
} from "@/lib/auth/authorize/breakGlass";

/**
 * Phase C4 — emergency access.
 *
 * Every identity input is server-derived. The client supplies only the patient,
 * a reason and a declared context; the actor, the facility and the staff
 * profile all come from the session, so a caller cannot activate emergency
 * access as somebody else or in another facility.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const actor = await buildAuthorizationActor(searchParams.get("facilityId") ?? undefined);

    await requireAuthorization({
      actor,
      action: "breakglass.review",
      resource: { type: "BREAK_GLASS", facilityId: actor.facilityId },
    });
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");

    // Tidy lapsed rows first so the operator view is not misleading. Purely
    // cosmetic: the engine derives expiry from the timestamp, so an unswept row
    // was already unusable.
    await expireLapsedBreakGlass(actor.facilityId);

    const [windows, report] = await Promise.all([
      listBreakGlass({
        facilityId: actor.facilityId,
        status: searchParams.get("status") ?? undefined,
        patientId: searchParams.get("patientId") ?? undefined,
      }),
      breakGlassAbuseReport(actor.facilityId),
    ]);
    return { windows, report, emergencyContexts: EMERGENCY_CONTEXTS };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const actor = await buildAuthorizationActor(body?.facilityId);

    if (!body?.patientId) throw new BadRequestError("patientId is required.");
    if (!body?.reason) throw new BadRequestError("A reason is required.");
    if (!body?.emergencyContext) throw new BadRequestError("An emergency context is required.");

    // Activating emergency access is itself an authorized action: facility
    // membership and an active staff profile are still required. Break-glass
    // relaxes the care-relationship policy and nothing else.
    await requireAuthorization({
      actor,
      action: "breakglass.activate",
      resource: { type: "PATIENT", id: body.patientId, facilityId: actor.facilityId, patientId: body.patientId },
    });
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");

    const window = await activateBreakGlass({
      facilityId: actor.facilityId,
      patientId: body.patientId,
      encounterId: body.encounterId ?? null,
      actorUserId: actor.userId,
      actorStaffId: actor.staffId,
      reason: body.reason,
      emergencyContext: body.emergencyContext,
      durationMs: typeof body.durationMs === "number" ? body.durationMs : undefined,
    });

    return {
      breakGlass: {
        id: window.id,
        correlationId: window.correlationId,
        expiresAt: window.expiresAt,
        status: window.status,
      },
    };
  });
}

/** Close a window early, or revoke one administratively. */
export async function PATCH(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const actor = await buildAuthorizationActor(body?.facilityId);
    if (!body?.breakGlassId) throw new BadRequestError("breakGlassId is required.");

    if (body.action === "revoke") {
      // Revocation is an administrative act, separately permissioned from
      // activation — the person who opened a window should not be the only
      // person who can close it, and closing someone else's requires authority.
      await requireAuthorization({
        actor, action: "breakglass.review",
        resource: { type: "BREAK_GLASS", facilityId: actor.facilityId },
      });
      if (!actor.facilityId) throw new BadRequestError("A facility is required.");
      const window = await revokeBreakGlass({
        facilityId: actor.facilityId, breakGlassId: body.breakGlassId,
        actorUserId: actor.userId, reason: body.reason,
      });
      return { breakGlass: window };
    }

    if (body.action === "complete") {
      await requireAuthorization({
        actor, action: "breakglass.activate",
        resource: { type: "BREAK_GLASS", facilityId: actor.facilityId },
      });
      if (!actor.facilityId) throw new BadRequestError("A facility is required.");
      // completeBreakGlass enforces owner-only closure internally.
      const window = await completeBreakGlass({
        facilityId: actor.facilityId, breakGlassId: body.breakGlassId, actorUserId: actor.userId,
      });
      return { breakGlass: window };
    }

    throw new BadRequestError("action must be complete or revoke.");
  });
}
