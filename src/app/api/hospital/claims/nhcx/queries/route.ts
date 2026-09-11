import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { buildAuthorizationActor } from "@/lib/auth/authorize/context";
import { requireAuthorization } from "@/lib/auth/authorize/engine";
import { listQueries, transitionQuery, respondToQuery } from "@/lib/hospital/nhcx/queries";
import type { QueryStatus } from "@/lib/hospital/nhcx/stateMachines";

/** Phase C5 — payer query / clarification workflow. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const actor = await buildAuthorizationActor(searchParams.get("facilityId") ?? undefined);
    await requireAuthorization({
      actor, action: "claim.read",
      resource: { type: "CLAIM", facilityId: actor.facilityId, dataClass: "FINANCIAL" },
    });
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");

    return {
      queries: await listQueries({
        facilityId: actor.facilityId,
        status: searchParams.get("status") ?? undefined,
        claimId: searchParams.get("claimId") ?? undefined,
      }),
    };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const actor = await buildAuthorizationActor(body?.facilityId);
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");
    if (!body?.queryId) throw new BadRequestError("queryId is required.");

    if (body.action === "respond") {
      // Disclosing documents to a payer is an adjustment to what leaves the
      // facility, so it carries the step-up policy rather than plain read.
      await requireAuthorization({
        actor, action: "claim.submit",
        resource: { type: "CLAIM", facilityId: actor.facilityId, dataClass: "FINANCIAL" },
        purpose: "INSURANCE",
      });
      // documentIds are only *candidates*: respondToQuery authorizes each one
      // individually and returns those it refused.
      const documentIds = Array.isArray(body.documentIds)
        ? body.documentIds.filter((d: unknown): d is string => typeof d === "string").slice(0, 50)
        : [];
      return respondToQuery({
        facilityId: actor.facilityId,
        queryId: body.queryId,
        responseText: String(body.responseText ?? ""),
        documentIds,
        actor,
      });
    }

    if (body.action === "transition") {
      await requireAuthorization({
        actor, action: "claim.read",
        resource: { type: "CLAIM", facilityId: actor.facilityId, dataClass: "FINANCIAL" },
      });
      if (!body?.to) throw new BadRequestError("to is required.");
      return {
        query: await transitionQuery({
          facilityId: actor.facilityId,
          queryId: body.queryId,
          to: body.to as QueryStatus,
          byUserId: actor.userId,
        }),
      };
    }

    throw new BadRequestError("action must be respond or transition.");
  });
}
