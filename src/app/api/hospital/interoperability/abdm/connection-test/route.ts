import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { getAbdmConfig } from "@/lib/hospital/interoperability/abdm/config";
import { checkAbdmHealth } from "@/lib/hospital/interoperability/abdm/health";
import { describeCallbackRoutes } from "@/lib/hospital/interoperability/abdm/callbacks";
import { describeProfileCoverage } from "@/lib/hospital/interoperability/fhir/profiles";

/**
 * Phase C2 — administrative ABDM connection test.
 *
 * GET  reports configured state WITHOUT touching the network, so opening a
 *      dashboard never authenticates against a national gateway.
 * POST performs a REAL handshake. It is the only route that does, requires the
 *      connection-management permission, and is audited.
 *
 * Neither ever returns a credential, and neither can mutate patient data.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("interop:overview:view", searchParams.get("facilityId") ?? undefined);
    const config = getAbdmConfig();
    const health = await checkAbdmHealth(config, { performHandshake: false });
    return {
      facilityId,
      health,
      callbackRoutes: describeCallbackRoutes(config),
      profiles: describeProfileCoverage(),
    };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("interop:connection:manage", body?.facilityId);

    const config = getAbdmConfig();
    // The only place in the product that opts into a live handshake.
    const health = await checkAbdmHealth(config, { performHandshake: true });

    await recordAuditEvent(
      "hospital.interop.connectionTested",
      session.userId,
      {
        environment: health.environment,
        state: health.state,
        handshakePerformed: health.handshakePerformed,
        latencyMs: health.latencyMs,
      },
      { facilityId }
    );

    return { health };
  });
}
