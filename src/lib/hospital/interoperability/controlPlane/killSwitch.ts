import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import type { AuthorizationActor } from "@/lib/auth/authorize/types";
import { assertKnownSystem, describeIntegration } from "./registry";
import { raiseAlert, resolveAlertsByType } from "./alerts";

/**
 * Phase C6 — integration kill switch.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ASYMMETRIC BY DESIGN.
 *
 * Disabling is easy: one permission, no step-up, no approval, always allowed,
 * always audited. During an incident the fail-safe direction must never be
 * obstructed.
 *
 * Enabling is hard: step-up, valid configuration, a verified contract, and for
 * production a separate approver. A kill switch that is as easy to release as
 * to pull is not a safety control.
 *
 * Disabling NEVER deletes an exchange record. In-flight work is left exactly as
 * it is so an operator can still see what was happening when they pulled the
 * switch; what stops is the creation of NEW external dispatches, enforced by
 * the outbound safety gate.
 * ════════════════════════════════════════════════════════════════════════════
 */

export async function disableIntegration(input: {
  facilityId: string; system: string; actor: AuthorizationActor; reason: string;
  /** EMERGENCY records an urgent operator shutdown; ROUTINE is ordinary admin. */
  mode?: "ROUTINE" | "EMERGENCY";
}) {
  const system = assertKnownSystem(input.system);
  if (!input.reason?.trim()) throw new BadRequestError("A reason is required to disable an integration.");
  const mode = input.mode ?? "ROUTINE";

  const connection = await prisma.interopConnection.findUnique({
    where: { facilityId_system: { facilityId: input.facilityId, system } },
  });
  if (!connection) throw new NotFoundError("Integration not found.");

  // Already disabled is success, not an error: an operator hammering the switch
  // during an incident must not get a failure back.
  if (!connection.enabled) {
    return { connection, alreadyDisabled: true };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const r = await tx.interopConnection.updateMany({
      where: { id: connection.id, enabled: true },
      data: {
        enabled: false,
        disabledAt: new Date(),
        disabledByUserId: input.actor.userId,
        disabledReason: input.reason.trim().slice(0, 500),
        configRevision: connection.configRevision + 1,
        version: { increment: 1 },
      },
    });
    // Lost the race to another disabler. The end state is still disabled, which
    // is what the caller wanted, so this is not an error.
    if (r.count !== 1) return tx.interopConnection.findUniqueOrThrow({ where: { id: connection.id } });

    const row = await tx.interopConnection.findUniqueOrThrow({ where: { id: connection.id } });
    await tx.integrationConfigRevision.create({
      data: {
        facilityId: input.facilityId, connectionId: row.id, revision: row.configRevision,
        changeKind: "DISABLE",
        snapshot: {
          environment: row.environment, enabled: row.enabled, baseUrl: row.baseUrl,
          clientIdEnvVar: row.clientIdEnvVar, status: row.status, protocolVersion: row.protocolVersion,
        } as never,
        reason: `${mode}: ${input.reason.trim()}`,
        changedByUserId: input.actor.userId,
      },
    });
    return row;
  });

  await recordAuditEvent(
    mode === "EMERGENCY" ? "hospital.interop.emergencyShutdown" : "hospital.interop.integrationDisabled",
    input.actor.userId,
    { system, mode, reason: input.reason.trim().slice(0, 200) },
    { facilityId: input.facilityId }
  );

  // A disabled integration is a visible operational state, not a silent one.
  await raiseAlert({
    facilityId: input.facilityId,
    system,
    connectionId: connection.id,
    alertType: "INTEGRATION_DISABLED",
    severity: mode === "EMERGENCY" ? "CRITICAL" : "WARNING",
    dedupeKey: `${system}:INTEGRATION_DISABLED`,
    detail: `${system} is disabled for this facility (${mode.toLowerCase()}): ${input.reason.trim().slice(0, 200)}`,
  });

  return { connection: updated, alreadyDisabled: false };
}

/**
 * Enable an integration.
 *
 * Re-derives readiness at the moment of enabling rather than trusting a stored
 * label, so an operator cannot switch on an integration whose contract is
 * unverified, whose configuration is incomplete, or whose production move has
 * not been approved.
 */
export async function enableIntegration(input: {
  facilityId: string; system: string; actor: AuthorizationActor;
}) {
  const system = assertKnownSystem(input.system);

  const connection = await prisma.interopConnection.findUnique({
    where: { facilityId_system: { facilityId: input.facilityId, system } },
  });
  if (!connection) throw new NotFoundError("Integration not found.");

  // Already enabled is success, mirroring disable. Only the CONCURRENT case
  // below is exactly-once; a caller re-asserting a state that already holds has
  // asked for nothing and should not get an error.
  if (connection.enabled) return connection;

  if (connection.environment === "DISABLED") {
    throw new BadRequestError("Select an environment before enabling this integration.");
  }
  if (connection.environment === "PRODUCTION" && !connection.productionApprovedAt) {
    throw new BadRequestError(
      "Production must be approved by a second authorised user before this integration can be enabled."
    );
  }

  // Ask the live view, not the row. This is what stops an enable from
  // outrunning the evidence.
  const view = await describeIntegration(input.facilityId, system);
  if (!view.descriptor.contractVerified) {
    throw new BadRequestError(
      view.descriptor.contractBlockedReason
      || "This integration's protocol contract is unverified, so it cannot be enabled."
    );
  }
  if (view.readiness.dimensions.configuration === "FAIL") {
    throw new BadRequestError(`Configuration is incomplete: ${view.readiness.blockers.join(" ")}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const r = await tx.interopConnection.updateMany({
      where: { id: connection.id, version: connection.version, enabled: false },
      data: {
        enabled: true,
        disabledAt: null,
        disabledByUserId: null,
        disabledReason: null,
        status: "CONFIGURED",
        configRevision: connection.configRevision + 1,
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ConflictError("That integration was changed concurrently.");
    const row = await tx.interopConnection.findUniqueOrThrow({ where: { id: connection.id } });
    await tx.integrationConfigRevision.create({
      data: {
        facilityId: input.facilityId, connectionId: row.id, revision: row.configRevision,
        changeKind: "ENABLE",
        snapshot: {
          environment: row.environment, enabled: row.enabled, baseUrl: row.baseUrl,
          clientIdEnvVar: row.clientIdEnvVar, status: row.status, protocolVersion: row.protocolVersion,
        } as never,
        changedByUserId: input.actor.userId,
      },
    });
    return row;
  });

  await recordAuditEvent(
    "hospital.interop.integrationEnabled",
    input.actor.userId,
    { system, environment: updated.environment },
    { facilityId: input.facilityId }
  );
  await resolveAlertsByType(input.facilityId, `${system}:INTEGRATION_DISABLED`);
  return updated;
}
