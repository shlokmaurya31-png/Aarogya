import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { buildAuthorizationActor } from "@/lib/auth/authorize/context";
import { requireAuthorization } from "@/lib/auth/authorize/engine";
import {
  listCertificates, registerCertificate, activateNextCertificate, sweepCertificates,
} from "@/lib/hospital/interoperability/controlPlane/certificates";
import { transitionAlert, listAlerts } from "@/lib/hospital/interoperability/controlPlane/alerts";

/**
 * Phase C6 — certificate lifecycle and operational alerts.
 *
 * This endpoint accepts a REFERENCE to where a certificate lives plus its
 * public descriptive fields. It refuses PEM material outright, and nothing it
 * returns includes key material or even the storage path — only whether one is
 * configured.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const actor = await buildAuthorizationActor(searchParams.get("facilityId") ?? undefined);
    await requireAuthorization({
      actor,
      action: "integration.read",
      resource: { type: "INTEGRATION", facilityId: actor.facilityId, dataClass: "OPERATIONAL" },
    });
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");

    await sweepCertificates(actor.facilityId);
    return {
      certificates: await listCertificates(actor.facilityId, searchParams.get("system") ?? undefined),
      alerts: await listAlerts({ facilityId: actor.facilityId, status: searchParams.get("alertStatus") ?? undefined }),
    };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const actor = await buildAuthorizationActor(body?.facilityId);
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");
    const facilityId = actor.facilityId;

    switch (body?.action) {
      case "register": {
        await requireAuthorization({
          actor, action: "integration.configure",
          resource: { type: "INTEGRATION", facilityId, dataClass: "OPERATIONAL" },
        });
        return {
          certificate: await registerCertificate({
            facilityId, actor,
            system: String(body.system ?? ""),
            usage: String(body.usage ?? ""),
            role: body.role,
            materialRef: String(body.materialRef ?? ""),
            subject: body.subject ?? null,
            issuer: body.issuer ?? null,
            serial: body.serial ?? null,
            fingerprint: body.fingerprint ?? null,
            notBefore: body.notBefore ? new Date(body.notBefore) : null,
            notAfter: body.notAfter ? new Date(body.notAfter) : null,
            activatesAt: body.activatesAt ? new Date(body.activatesAt) : null,
          }),
        };
      }

      case "activateNext": {
        await requireAuthorization({
          actor, action: "integration.configure",
          resource: { type: "INTEGRATION", facilityId, dataClass: "OPERATIONAL" },
        });
        return {
          certificate: await activateNextCertificate({
            facilityId, actor, system: String(body.system ?? ""), usage: String(body.usage ?? ""),
          }),
          // Said plainly, because this endpoint records a rotation rather than
          // performing one.
          note: "Aarogya's record has been updated. The corresponding change in the deployment's secret store is a separate operator action.",
        };
      }

      case "transitionAlert": {
        await requireAuthorization({
          actor, action: "integration.configure",
          resource: { type: "INTEGRATION", facilityId, dataClass: "OPERATIONAL" },
        });
        if (!body.alertId) throw new BadRequestError("alertId is required.");
        return {
          alert: await transitionAlert({
            facilityId,
            alertId: String(body.alertId),
            to: body.to === "RESOLVED" ? "RESOLVED" : "ACKNOWLEDGED",
            note: body.note ? String(body.note) : undefined,
            byUserId: actor.userId,
          }),
        };
      }

      default:
        throw new BadRequestError("action must be register, activateNext or transitionAlert.");
    }
  });
}
