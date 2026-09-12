import { NextRequest } from "next/server";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { buildAuthorizationActor } from "@/lib/auth/authorize/context";
import { requireAuthorization } from "@/lib/auth/authorize/engine";
import { listIntegrations, describeIntegration, assertKnownSystem } from "@/lib/hospital/interoperability/controlPlane/registry";
import {
  configureIntegration, approveProduction, rollbackConfiguration,
  listRevisions, assertNoSecrets, validateConfiguration,
} from "@/lib/hospital/interoperability/controlPlane/configuration";
import { enableIntegration, disableIntegration } from "@/lib/hospital/interoperability/controlPlane/killSwitch";
import { collectMetrics, sweepOperationalAlerts } from "@/lib/hospital/interoperability/controlPlane/operations";
import { listAlerts } from "@/lib/hospital/interoperability/controlPlane/alerts";
import { sweepCertificates, listCertificates } from "@/lib/hospital/interoperability/controlPlane/certificates";

/**
 * Phase C6 — integration control plane.
 *
 * Every identity input is server-derived: the facility comes from the session
 * through `buildAuthorizationActor`, never from the body, so a caller cannot
 * name another facility and have it honoured. The system name IS taken from the
 * request, but it is validated against a closed set of three.
 *
 * No response from this route contains a credential. The registry returns only
 * redacted descriptions (`describeAbdmConfig` / `describeNhcxConfig`), which
 * report whether a value is present and never what it is.
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
    const facilityId = actor.facilityId;

    const system = searchParams.get("system");
    if (system) {
      const s = assertKnownSystem(system);
      const [view, revisions, certificates] = await Promise.all([
        describeIntegration(facilityId, s),
        listRevisions(facilityId, s),
        listCertificates(facilityId, s),
      ]);
      return { integration: view, revisions, certificates };
    }

    // Sweeping on read keeps alerts deterministic and current without a
    // scheduler: the same database state always yields the same alert set.
    await sweepCertificates(facilityId);
    await sweepOperationalAlerts(facilityId);

    const [integrations, metrics, alerts, certificates] = await Promise.all([
      listIntegrations(facilityId),
      collectMetrics(facilityId),
      listAlerts({ facilityId, status: "OPEN" }),
      listCertificates(facilityId),
    ]);

    return { integrations, metrics, alerts, certificates };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body?.action) throw new BadRequestError("action is required.");
    // Refuse credential-shaped input before anything else touches it.
    assertNoSecrets(body);

    const actor = await buildAuthorizationActor(body.facilityId as string | undefined);
    if (!actor.facilityId) throw new BadRequestError("A facility is required.");
    const facilityId = actor.facilityId;
    const system = String(body.system ?? "");

    switch (body.action) {
      case "validate": {
        await requireAuthorization({
          actor, action: "integration.read",
          resource: { type: "INTEGRATION", facilityId, dataClass: "OPERATIONAL" },
        });
        return {
          validation: validateConfiguration({
            system: assertKnownSystem(system),
            environment: String(body.environment ?? "DISABLED"),
            baseUrl: (body.baseUrl as string) ?? null,
            clientIdEnvVar: (body.clientIdEnvVar as string) ?? null,
            callbackUrl: (body.callbackUrl as string) ?? null,
          }),
        };
      }

      case "configure": {
        await requireAuthorization({
          actor, action: "integration.configure",
          resource: { type: "INTEGRATION", facilityId, dataClass: "OPERATIONAL" },
        });
        return configureIntegration({
          facilityId, system, actor,
          environment: body.environment as string | undefined,
          baseUrl: body.baseUrl as string | null | undefined,
          clientIdEnvVar: body.clientIdEnvVar as string | null | undefined,
          protocolVersion: body.protocolVersion as string | null | undefined,
          reason: body.reason as string | undefined,
        });
      }

      case "enable": {
        await requireAuthorization({
          actor, action: "integration.enable",
          resource: { type: "INTEGRATION", facilityId, dataClass: "OPERATIONAL" },
        });
        return { connection: await enableIntegration({ facilityId, system, actor }) };
      }

      case "disable": {
        // Deliberately the lighter policy: stopping external traffic must not be
        // obstructed during an incident.
        await requireAuthorization({
          actor, action: "integration.disable",
          resource: { type: "INTEGRATION", facilityId, dataClass: "OPERATIONAL" },
        });
        return disableIntegration({
          facilityId, system, actor,
          reason: String(body.reason ?? ""),
          mode: body.mode === "EMERGENCY" ? "EMERGENCY" : "ROUTINE",
        });
      }

      case "approveProduction": {
        await requireAuthorization({
          actor, action: "integration.approveProduction",
          resource: { type: "INTEGRATION", facilityId, dataClass: "OPERATIONAL" },
        });
        return { connection: await approveProduction({ facilityId, system, actor, note: String(body.note ?? "") }) };
      }

      case "rollback": {
        await requireAuthorization({
          actor, action: "integration.configure",
          resource: { type: "INTEGRATION", facilityId, dataClass: "OPERATIONAL" },
        });
        if (typeof body.revision !== "number") throw new BadRequestError("revision must be a number.");
        return {
          connection: await rollbackConfiguration({
            facilityId, system, revision: body.revision, actor, reason: String(body.reason ?? ""),
          }),
        };
      }

      default:
        throw new BadRequestError(
          "action must be validate, configure, enable, disable, approveProduction or rollback."
        );
    }
  });
}
