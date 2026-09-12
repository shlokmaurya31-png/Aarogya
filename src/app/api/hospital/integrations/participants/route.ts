import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { buildAuthorizationActor } from "@/lib/auth/authorize/context";
import { requireAuthorization } from "@/lib/auth/authorize/engine";
import {
  listParticipants, registerParticipant, setParticipantTrust,
} from "@/lib/hospital/interoperability/controlPlane/participants";

/** Phase C6 — external participant registry. Facility-scoped throughout. */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const actor = await buildAuthorizationActor(searchParams.get("facilityId") ?? undefined);
    await requireAuthorization({
      actor,
      action: "integration.read",
      resource: { type: "PARTICIPANT", facilityId: actor.facilityId, dataClass: "OPERATIONAL" },
    });
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");

    return {
      participants: await listParticipants({
        facilityId: actor.facilityId,
        system: searchParams.get("system") ?? undefined,
        type: searchParams.get("type") ?? undefined,
        trustStatus: searchParams.get("trustStatus") ?? undefined,
      }),
    };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const actor = await buildAuthorizationActor(body?.facilityId);
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");
    const facilityId = actor.facilityId;

    if (body?.action === "register") {
      await requireAuthorization({
        actor, action: "integration.participant.manage",
        resource: { type: "PARTICIPANT", facilityId, dataClass: "OPERATIONAL" },
      });
      return {
        participant: await registerParticipant({
          facilityId, actor,
          system: String(body.system ?? ""),
          type: String(body.type ?? ""),
          name: String(body.name ?? ""),
          externalId: String(body.externalId ?? ""),
          externalIdSystem: body.externalIdSystem ?? null,
          environment: body.environment,
          payerId: body.payerId ?? null,
        }),
      };
    }

    if (body?.action === "setTrust") {
      // Trust is a separate, step-up gated permission from registration: adding
      // a counterparty to the list and deciding to rely on it are different acts.
      await requireAuthorization({
        actor, action: "integration.participant.verify",
        resource: { type: "PARTICIPANT", id: body.participantId, facilityId, dataClass: "OPERATIONAL" },
      });
      if (!body.participantId) throw new BadRequestError("participantId is required.");
      return {
        participant: await setParticipantTrust({
          facilityId,
          participantId: String(body.participantId),
          to: String(body.to ?? ""),
          note: String(body.note ?? ""),
          actor,
        }),
      };
    }

    throw new BadRequestError("action must be register or setTrust.");
  });
}
