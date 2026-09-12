import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { buildAuthorizationActor } from "@/lib/auth/authorize/context";
import { requireAuthorization } from "@/lib/auth/authorize/engine";
import { recordAuditEvent } from "@/lib/auth/audit";
import {
  listUnifiedExchanges, getExchangeTimeline, listUnifiedCallbacks,
  type OperationalState,
} from "@/lib/hospital/interoperability/controlPlane/exchanges";
import { manualRetry } from "@/lib/hospital/interoperability/controlPlane/operations";

/**
 * Phase C6 — unified exchange operations.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * OPERATIONAL VISIBILITY IS NOT CLINICAL ACCESS.
 *
 * Seeing that an exchange failed, which category it failed with and how many
 * attempts it has left requires `integration.read` — an OPERATIONAL policy with
 * no patient dimension. It returns correlation ids, states and counts.
 *
 * It does NOT return the bundle, the claim package, the documents or any
 * clinical field, and there is no parameter that makes it. An operator who
 * needs the payload goes through the clinical or claims surface and is
 * authorized there, against the patient, by the C4 engine.
 * ════════════════════════════════════════════════════════════════════════════
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const actor = await buildAuthorizationActor(searchParams.get("facilityId") ?? undefined);
    await requireAuthorization({
      actor,
      action: "integration.read",
      resource: { type: "EXCHANGE", facilityId: actor.facilityId, dataClass: "OPERATIONAL" },
    });
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");
    const facilityId = actor.facilityId;

    const view = searchParams.get("view");
    if (view === "callbacks") {
      return {
        callbacks: await listUnifiedCallbacks({
          facilityId,
          status: searchParams.get("status") ?? undefined,
          system: searchParams.get("system") ?? undefined,
        }),
      };
    }

    const id = searchParams.get("id");
    const source = searchParams.get("source");
    if (id) {
      if (source !== "ABDM" && source !== "NHCX") {
        throw new BadRequestError("source must be ABDM or NHCX.");
      }
      const result = await getExchangeTimeline(facilityId, source, id);
      // Inspecting one exchange is itself an audited act: operational screens
      // are a legitimate place to notice who has been looking at what.
      await recordAuditEvent(
        "hospital.interop.exchangeViewed",
        actor.userId,
        { source, exchangeId: id, correlationId: result.exchange?.correlationId ?? null },
        { facilityId }
      );
      return result;
    }

    return {
      exchanges: await listUnifiedExchanges({
        facilityId,
        system: searchParams.get("system") ?? undefined,
        state: (searchParams.get("state") as OperationalState) ?? undefined,
        requiresReviewOnly: searchParams.get("requiresReview") === "true",
      }),
    };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const actor = await buildAuthorizationActor(body?.facilityId);
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");

    if (body?.action !== "retry") throw new BadRequestError("action must be retry.");
    if (body.source !== "ABDM" && body.source !== "NHCX") {
      throw new BadRequestError("source must be ABDM or NHCX.");
    }
    if (!body.exchangeId) throw new BadRequestError("exchangeId is required.");

    await requireAuthorization({
      actor,
      action: "integration.exchange.retry",
      resource: { type: "EXCHANGE", id: body.exchangeId, facilityId: actor.facilityId, dataClass: "OPERATIONAL" },
    });

    return manualRetry({
      facilityId: actor.facilityId,
      source: body.source,
      exchangeId: String(body.exchangeId),
      actor,
      reason: String(body.reason ?? ""),
    });
  });
}
