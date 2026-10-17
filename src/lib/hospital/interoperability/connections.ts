import { $Enums } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseOptionalEnum } from "@/lib/enumValue";
import { BadRequestError } from "@/lib/auth/rbac";
import { INTEROP_SYSTEMS, INTEROP_ENVIRONMENTS, assertOneOf } from "./shared";

/**
 * A facility's connection settings for an external system (batch 7, item 5;
 * previously written by its route). Configuration, so it emits nothing
 * (CONFIGURATION in emitExemptions.ts); credentials are refused outright and
 * live only in the deployment environment.
 */
export async function configureInteropConnection(input: {
  facilityId: string; system: string; environment?: string; enabled?: boolean; baseUrl?: string | null; clientIdEnvVar?: string | null;
  /** The raw request body, checked for anything that looks like a credential. */
  raw?: Record<string, unknown>;
}) {
  if (!input.system) throw new BadRequestError("system is required.");
  assertOneOf(input.system, INTEROP_SYSTEMS, "external system");
  if (input.environment) assertOneOf(input.environment, INTEROP_ENVIRONMENTS, "environment");
  const environment = parseOptionalEnum($Enums.IntegrationEnvironment, input.environment, "environment");
  // Reject anything that looks like a credential. Secrets belong in the
  // deployment environment; persisting one here would put it in the database,
  // the backups and every audit export.
  for (const forbidden of ["clientSecret", "client_secret", "secret", "token", "certificate", "privateKey"]) {
    if (input.raw?.[forbidden] !== undefined) throw new BadRequestError("Credentials are never stored in the database. Set them as environment variables instead.");
  }
  return prisma.interopConnection.upsert({
    where: { facilityId_system: { facilityId: input.facilityId, system: input.system } },
    create: {
      facilityId: input.facilityId, system: input.system, environment: environment ?? "DISABLED", enabled: input.enabled === true,
      baseUrl: input.baseUrl ?? null, clientIdEnvVar: input.clientIdEnvVar ?? null,
      status: environment && environment !== "DISABLED" ? "CONFIGURED" : "NOT_CONFIGURED",
    },
    update: {
      ...(environment ? { environment } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled === true } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.clientIdEnvVar !== undefined ? { clientIdEnvVar: input.clientIdEnvVar } : {}),
      ...(environment ? { status: environment === "DISABLED" ? "NOT_CONFIGURED" : "CONFIGURED" } : {}),
      version: { increment: 1 },
    },
  });
}
