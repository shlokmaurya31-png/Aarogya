import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { buildAuthorizationActor, resolveSelfPatient } from "@/lib/auth/authorize/context";
import { requireAuthorization } from "@/lib/auth/authorize/engine";
import {
  createPrivacyRequest, listPrivacyRequests, transitionPrivacyRequest, setLegalHold,
  describeRetention, PRIVACY_REQUEST_TYPES,
} from "@/lib/auth/authorize/privacy";

/**
 * Phase C4 — privacy requests.
 *
 * The security-critical property here is that a PATIENT account is confined to
 * its OWN requests. That confinement is derived from the session
 * (`resolveSelfPatient`), never from a patientId in the query string — which is
 * exactly the IDOR this endpoint would otherwise introduce.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const actor = await buildAuthorizationActor(searchParams.get("facilityId") ?? undefined);

    await requireAuthorization({
      actor,
      action: "privacy.request.read",
      resource: { type: "PRIVACY_REQUEST", facilityId: actor.facilityId },
    });

    const self = await resolveSelfPatient(actor);
    // A patient session is pinned to its own patient id and its own facility.
    const facilityId = self?.facilityId ?? actor.facilityId;
    if (!facilityId) throw new BadRequestError("A facility is required.");

    const requests = await listPrivacyRequests({
      facilityId,
      status: searchParams.get("status") ?? undefined,
      patientId: searchParams.get("patientId") ?? undefined,
      restrictToPatientId: self?.id ?? null,
    });
    return { requests, requestTypes: PRIVACY_REQUEST_TYPES, retention: describeRetention() };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const actor = await buildAuthorizationActor(body?.facilityId);

    await requireAuthorization({
      actor,
      action: "privacy.request.create",
      resource: { type: "PRIVACY_REQUEST", facilityId: actor.facilityId },
    });

    const self = await resolveSelfPatient(actor);
    // A patient may only ever raise a request about themselves. The patient id
    // is taken from the session, and a body-supplied one is ignored entirely.
    const patientId = self?.id ?? body?.patientId;
    const facilityId = self?.facilityId ?? actor.facilityId;
    if (!patientId) throw new BadRequestError("patientId is required.");
    if (!facilityId) throw new BadRequestError("A facility is required.");
    if (!body?.requestType) throw new BadRequestError("requestType is required.");

    const request = await createPrivacyRequest({
      facilityId,
      patientId,
      requestType: body.requestType,
      requesterType: self ? "PATIENT" : (body.requesterType ?? "STAFF_ON_BEHALF"),
      requesterUserId: actor.userId,
      scope: body.scope,
      reason: body.reason,
    });
    return { request };
  });
}

/** Review, decide, action, or set a legal hold. */
export async function PATCH(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const actor = await buildAuthorizationActor(body?.facilityId);

    await requireAuthorization({
      actor,
      action: "privacy.request.review",
      resource: { type: "PRIVACY_REQUEST", facilityId: actor.facilityId },
    });
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");
    if (!body?.privacyRequestId) throw new BadRequestError("privacyRequestId is required.");

    if (body.action === "legalHold") {
      const request = await setLegalHold({
        facilityId: actor.facilityId,
        privacyRequestId: body.privacyRequestId,
        hold: body.hold === true,
        reason: body.reason,
        byUserId: actor.userId,
      });
      return { request };
    }

    if (!body?.to) throw new BadRequestError("to is required.");
    const request = await transitionPrivacyRequest({
      facilityId: actor.facilityId,
      privacyRequestId: body.privacyRequestId,
      to: body.to,
      byUserId: actor.userId,
      decisionNote: body.decisionNote,
    });
    return { request };
  });
}
