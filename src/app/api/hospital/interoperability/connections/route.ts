import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { INTEROP_SYSTEMS, INTEROP_ENVIRONMENTS, assertOneOf } from "@/lib/hospital/interoperability/shared";
import { getAbdmConfig, describeAbdmConfig, checkEnvironmentSafety } from "@/lib/hospital/interoperability/config";
import { getExchangeAdapter } from "@/lib/hospital/interoperability/adapters/abdm";

/**
 * Phase C1 — per-facility external system configuration and live capability.
 *
 * The response deliberately separates what an OPERATOR configured from what the
 * process can ACTUALLY do. A connection row saying PRODUCTION means nothing if
 * the environment has no credentials, and this endpoint says so rather than
 * letting a dashboard imply connectivity that does not exist.
 */
export async function GET(req: NextRequest) {
  return withApiErrors(async () => {
    const { searchParams } = new URL(req.url);
    const { facilityId } = await requireFacilityStaff("interop:overview:view", searchParams.get("facilityId") ?? undefined);

    const connections = await prisma.interopConnection.findMany({ where: { facilityId }, orderBy: { system: "asc" } });
    const abdm = getAbdmConfig();
    const safety = checkEnvironmentSafety(abdm);
    const adapter = getExchangeAdapter("ABDM");
    const capabilities = await adapter.capabilities();

    return {
      connections,
      // Runtime truth, never the stored intent. No secret is included.
      runtime: {
        abdm: describeAbdmConfig(abdm),
        capabilities,
        safe: safety.safe,
        warning: safety.warning,
      },
    };
  });
}

export async function PATCH(req: NextRequest) {
  return withApiErrors(async () => {
    const body = await req.json().catch(() => null);
    const { session, facilityId } = await requireFacilityStaff("interop:connection:manage", body?.facilityId);
    if (!body?.system) throw new BadRequestError("system is required.");
    assertOneOf(body.system, INTEROP_SYSTEMS, "external system");
    if (body.environment) assertOneOf(body.environment, INTEROP_ENVIRONMENTS, "environment");

    // Reject anything that looks like a credential. Secrets belong in the
    // deployment environment; persisting one here would put it in the database,
    // the backups and every audit export.
    for (const forbidden of ["clientSecret", "client_secret", "secret", "token", "certificate", "privateKey"]) {
      if (body[forbidden] !== undefined) {
        throw new BadRequestError("Credentials are never stored in the database. Set them as environment variables instead.");
      }
    }

    const connection = await prisma.interopConnection.upsert({
      where: { facilityId_system: { facilityId, system: body.system } },
      create: {
        facilityId,
        system: body.system,
        environment: body.environment ?? "DISABLED",
        enabled: body.enabled === true,
        baseUrl: body.baseUrl ?? null,
        clientIdEnvVar: body.clientIdEnvVar ?? null,
        status: body.environment && body.environment !== "DISABLED" ? "CONFIGURED" : "NOT_CONFIGURED",
      },
      update: {
        ...(body.environment ? { environment: body.environment } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled === true } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
        ...(body.clientIdEnvVar !== undefined ? { clientIdEnvVar: body.clientIdEnvVar } : {}),
        ...(body.environment ? { status: body.environment === "DISABLED" ? "NOT_CONFIGURED" : "CONFIGURED" } : {}),
        version: { increment: 1 },
      },
    });

    await recordAuditEvent(
      "hospital.interop.connectionConfigured",
      session.userId,
      { system: connection.system, environment: connection.environment, enabled: connection.enabled },
      { facilityId }
    );
    return { connection };
  });
}
