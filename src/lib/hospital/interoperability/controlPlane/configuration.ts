import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import type { AuthorizationActor } from "@/lib/auth/authorize/types";
import { assertKnownSystem, type IntegrationSystem } from "./registry";

/**
 * Phase C6 — integration configuration, enablement and production approval.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THREE RULES DRIVE EVERY FUNCTION HERE.
 *
 * 1. NO SECRET EVER REACHES THE DATABASE. The connection row holds an
 *    environment-variable NAME and a base URL. `assertNoSecrets` rejects a
 *    request that even looks like it carries credential material, so a
 *    well-meaning operator cannot paste a client secret into a form and have it
 *    land in the database, the backups and every audit export.
 *
 * 2. PRODUCTION IS NEVER INFERRED. Not from a URL, not from the presence of
 *    credentials, not from a successful sandbox run. It requires an explicit
 *    environment, an explicit enable, and an approval from a DIFFERENT user who
 *    holds a different permission.
 *
 * 3. EVERY ACCEPTED CHANGE WRITES A REVISION. Rollback is replaying a stored
 *    snapshot, not reconstructing intent from an audit log.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const CONTROL_PLANE_ENVIRONMENTS = ["DISABLED", "LOCAL", "SANDBOX", "PRODUCTION"] as const;
export type ControlPlaneEnvironment = (typeof CONTROL_PLANE_ENVIRONMENTS)[number];

/**
 * Request keys that would carry credential material. Checked by NAME rather
 * than by trying to recognise a secret's shape, because shape detection fails
 * open and a name check fails closed.
 */
const FORBIDDEN_KEYS = [
  "clientSecret", "client_secret", "secret", "secretValue", "token", "accessToken",
  "refreshToken", "apiKey", "api_key", "password", "passphrase",
  "certificate", "cert", "privateKey", "private_key", "pem", "key",
];

export function assertNoSecrets(body: Record<string, unknown>) {
  for (const k of Object.keys(body)) {
    if (FORBIDDEN_KEYS.includes(k)) {
      throw new BadRequestError(
        "Credentials are never stored in the database. Set them as environment variables and configure only the variable name here."
      );
    }
  }
  // A value that is obviously PEM material is refused wherever it appears, even
  // under an innocuous key name.
  for (const v of Object.values(body)) {
    if (typeof v === "string" && /-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/.test(v)) {
      throw new BadRequestError("Key or certificate material must never be submitted to this endpoint.");
    }
  }
}

export interface ConfigurationValidation {
  valid: boolean;
  missing: string[];
  invalid: string[];
  warnings: string[];
}

/**
 * Validate a proposed configuration. Structural only — it cannot and does not
 * check that a credential is correct, and deliberately never reports on the
 * VALUE of anything secret.
 */
export function validateConfiguration(input: {
  system: IntegrationSystem;
  environment: string;
  baseUrl?: string | null;
  clientIdEnvVar?: string | null;
  callbackUrl?: string | null;
}): ConfigurationValidation {
  const missing: string[] = [];
  const invalid: string[] = [];
  const warnings: string[] = [];

  if (!(CONTROL_PLANE_ENVIRONMENTS as readonly string[]).includes(input.environment)) {
    invalid.push(`environment must be one of ${CONTROL_PLANE_ENVIRONMENTS.join(", ")}`);
  }

  if (input.environment === "DISABLED") {
    return { valid: invalid.length === 0, missing, invalid, warnings };
  }

  // FHIR composes in-process and needs no endpoint at all.
  if (input.system !== "FHIR") {
    if (!input.baseUrl) missing.push("baseUrl");
    else if (!/^https?:\/\//i.test(input.baseUrl)) invalid.push("baseUrl must be an absolute http(s) URL");
    else if (input.environment !== "LOCAL" && !/^https:\/\//i.test(input.baseUrl)) {
      // Clinical and financial payloads cross this link.
      invalid.push("baseUrl must use https outside LOCAL");
    }
    if (!input.clientIdEnvVar) missing.push("clientIdEnvVar");
    else if (!/^[A-Z][A-Z0-9_]*$/.test(input.clientIdEnvVar)) {
      // A NAME, not a value. Rejecting anything that is not a plausible env-var
      // name is the cheapest way to stop a real client id being pasted here.
      invalid.push("clientIdEnvVar must be an environment variable NAME (UPPER_SNAKE_CASE), not a value");
    }
  }

  if (input.callbackUrl) {
    if (!/^https:\/\//i.test(input.callbackUrl) && input.environment !== "LOCAL") {
      invalid.push("callbackUrl must use https outside LOCAL");
    }
  }

  if (input.environment === "PRODUCTION") {
    warnings.push("Production requires approval by a second authorised user before it will dispatch.");
  }

  return { valid: missing.length === 0 && invalid.length === 0, missing, invalid, warnings };
}

/** The non-secret snapshot stored in a revision. */
function snapshotOf(row: {
  environment: string; enabled: boolean; baseUrl: string | null;
  clientIdEnvVar: string | null; status: string; protocolVersion: string | null;
}) {
  return {
    environment: row.environment,
    enabled: row.enabled,
    baseUrl: row.baseUrl,
    clientIdEnvVar: row.clientIdEnvVar,
    status: row.status,
    protocolVersion: row.protocolVersion,
  };
}

async function writeRevision(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  args: {
    facilityId: string; connectionId: string; revision: number;
    changeKind: string; snapshot: object; changedFields?: string[];
    reason?: string | null; changedByUserId: string;
  }
) {
  await tx.integrationConfigRevision.create({
    data: {
      facilityId: args.facilityId,
      connectionId: args.connectionId,
      revision: args.revision,
      changeKind: args.changeKind,
      snapshot: args.snapshot as never,
      changedFields: args.changedFields?.length ? args.changedFields.join(",") : null,
      reason: args.reason ?? null,
      changedByUserId: args.changedByUserId,
    },
  });
}

/**
 * Create or amend a facility's integration configuration.
 *
 * Changing configuration ALWAYS clears production approval and both
 * verification timestamps: evidence gathered against the old configuration says
 * nothing about the new one, and letting a SANDBOX_VERIFIED badge survive a
 * base-URL change would be exactly the kind of stale label this phase exists to
 * prevent.
 */
export async function configureIntegration(input: {
  facilityId: string;
  system: string;
  actor: AuthorizationActor;
  environment?: string;
  baseUrl?: string | null;
  clientIdEnvVar?: string | null;
  protocolVersion?: string | null;
  reason?: string;
}) {
  const system = assertKnownSystem(input.system);

  const existing = await prisma.interopConnection.findUnique({
    where: { facilityId_system: { facilityId: input.facilityId, system } },
  });

  const environment = input.environment ?? existing?.environment ?? "DISABLED";
  const baseUrl = input.baseUrl !== undefined ? input.baseUrl : existing?.baseUrl ?? null;
  const clientIdEnvVar = input.clientIdEnvVar !== undefined ? input.clientIdEnvVar : existing?.clientIdEnvVar ?? null;

  const validation = validateConfiguration({ system, environment, baseUrl, clientIdEnvVar });
  if (!validation.valid) {
    throw new BadRequestError(
      `Configuration is not valid. ${[...validation.missing.map((m) => `missing ${m}`), ...validation.invalid].join("; ")}.`
    );
  }

  const changedFields: string[] = [];
  if (existing) {
    if (existing.environment !== environment) changedFields.push("environment");
    if (existing.baseUrl !== baseUrl) changedFields.push("baseUrl");
    if (existing.clientIdEnvVar !== clientIdEnvVar) changedFields.push("clientIdEnvVar");
    if (input.protocolVersion !== undefined && existing.protocolVersion !== input.protocolVersion) {
      changedFields.push("protocolVersion");
    }
  }

  const connection = await prisma.$transaction(async (tx) => {
    if (!existing) {
      const created = await tx.interopConnection.create({
        data: {
          facilityId: input.facilityId,
          system,
          environment,
          // A brand-new integration is never born enabled.
          enabled: false,
          baseUrl,
          clientIdEnvVar,
          protocolVersion: input.protocolVersion ?? null,
          status: environment === "DISABLED" ? "NOT_CONFIGURED" : "CONFIGURED",
          configRevision: 1,
        },
      });
      await writeRevision(tx, {
        facilityId: input.facilityId, connectionId: created.id, revision: 1,
        changeKind: "CREATE", snapshot: snapshotOf(created),
        reason: input.reason, changedByUserId: input.actor.userId,
      });
      return created;
    }

    // Guarded update: a concurrent configuration change loses rather than
    // producing a hybrid of two operators' intentions.
    const nextRevision = existing.configRevision + 1;
    const r = await tx.interopConnection.updateMany({
      where: { id: existing.id, version: existing.version },
      data: {
        environment,
        baseUrl,
        clientIdEnvVar,
        ...(input.protocolVersion !== undefined ? { protocolVersion: input.protocolVersion } : {}),
        status: environment === "DISABLED" ? "NOT_CONFIGURED" : "CONFIGURED",
        // Reconfiguration invalidates prior evidence and prior approval.
        productionApprovedByUserId: null,
        productionApprovedAt: null,
        productionApprovalNote: null,
        sandboxVerifiedAt: null,
        productionVerifiedAt: null,
        // And it switches the integration off. Going live again is an explicit,
        // separately audited act.
        enabled: false,
        configRevision: nextRevision,
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) {
      throw new ConflictError("That integration was changed concurrently. Reload and try again.");
    }
    const updated = await tx.interopConnection.findUniqueOrThrow({ where: { id: existing.id } });
    await writeRevision(tx, {
      facilityId: input.facilityId, connectionId: updated.id, revision: nextRevision,
      changeKind: "UPDATE", snapshot: snapshotOf(updated), changedFields,
      reason: input.reason, changedByUserId: input.actor.userId,
    });
    return updated;
  });

  await recordAuditEvent(
    "hospital.interop.integrationConfigured",
    input.actor.userId,
    {
      system, environment: connection.environment, revision: connection.configRevision,
      changedFields, approvalCleared: !!existing,
    },
    { facilityId: input.facilityId }
  );

  return { connection, validation };
}

/**
 * Approve a facility's move to production. The CHECKER half of maker/checker.
 *
 * Refuses when the approver is the same person who last configured the
 * integration. That is the whole point of the control: one person must not be
 * able to point a facility at a live national gateway on their own.
 */
export async function approveProduction(input: {
  facilityId: string; system: string; actor: AuthorizationActor; note: string;
}) {
  const system = assertKnownSystem(input.system);
  if (!input.note?.trim()) throw new BadRequestError("An approval note is required.");

  const connection = await prisma.interopConnection.findUnique({
    where: { facilityId_system: { facilityId: input.facilityId, system } },
  });
  if (!connection) throw new NotFoundError("Integration not found.");
  if (connection.environment !== "PRODUCTION") {
    throw new BadRequestError("Only a PRODUCTION configuration can be approved for production.");
  }

  const lastConfigChange = await prisma.integrationConfigRevision.findFirst({
    where: { connectionId: connection.id, changeKind: { in: ["CREATE", "UPDATE", "ROLLBACK"] } },
    orderBy: { revision: "desc" },
  });
  if (lastConfigChange && lastConfigChange.changedByUserId === input.actor.userId) {
    throw new BadRequestError(
      "The user who configured this integration cannot also approve it for production. A second authorised user must approve."
    );
  }

  // Validate the STORED configuration, not the running process's credentials.
  //
  // These are deliberately different questions. Approval says "this facility's
  // configuration is correct and I accept the risk of it going live"; whether
  // the deployment currently holds valid credentials is a separate, later
  // question answered by `canDispatch` at the moment of dispatch. Collapsing
  // them would mean nobody could approve from anywhere but the box holding the
  // environment variables, and would fold two independent readiness dimensions
  // into one.
  const storedConfig = validateConfiguration({
    system,
    environment: connection.environment,
    baseUrl: connection.baseUrl,
    clientIdEnvVar: connection.clientIdEnvVar,
  });
  if (!storedConfig.valid) {
    throw new BadRequestError(
      `Production cannot be approved while the stored configuration is incomplete: ` +
      `${[...storedConfig.missing.map((m) => `missing ${m}`), ...storedConfig.invalid].join("; ")}.`
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const r = await tx.interopConnection.updateMany({
      // Guarded on approval still being absent, so two concurrent approvals
      // cannot both win.
      where: { id: connection.id, version: connection.version, productionApprovedAt: null },
      data: {
        productionApprovedByUserId: input.actor.userId,
        productionApprovedAt: new Date(),
        productionApprovalNote: input.note.trim().slice(0, 500),
        configRevision: connection.configRevision + 1,
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ConflictError("That integration was already approved or changed concurrently.");
    const row = await tx.interopConnection.findUniqueOrThrow({ where: { id: connection.id } });
    await writeRevision(tx, {
      facilityId: input.facilityId, connectionId: row.id, revision: row.configRevision,
      changeKind: "PRODUCTION_APPROVAL", snapshot: snapshotOf(row),
      reason: input.note, changedByUserId: input.actor.userId,
    });
    return row;
  });

  await recordAuditEvent(
    "hospital.interop.productionApproved",
    input.actor.userId,
    { system, environment: updated.environment, approvedBy: input.actor.userId },
    { facilityId: input.facilityId }
  );
  return updated;
}

/**
 * Roll configuration back to a stored revision.
 *
 * Rollback is itself a change: it writes a NEW revision rather than deleting
 * history, and it re-clears approval and verification exactly like any other
 * configuration change. There is no automatic rollback anywhere — a human
 * chooses the revision.
 */
export async function rollbackConfiguration(input: {
  facilityId: string; system: string; revision: number; actor: AuthorizationActor; reason: string;
}) {
  const system = assertKnownSystem(input.system);
  if (!input.reason?.trim()) throw new BadRequestError("A reason is required to roll configuration back.");

  const connection = await prisma.interopConnection.findUnique({
    where: { facilityId_system: { facilityId: input.facilityId, system } },
  });
  if (!connection) throw new NotFoundError("Integration not found.");

  const target = await prisma.integrationConfigRevision.findUnique({
    where: { connectionId_revision: { connectionId: connection.id, revision: input.revision } },
  });
  if (!target || target.facilityId !== input.facilityId) throw new NotFoundError("Revision not found.");

  const snap = target.snapshot as {
    environment: string; baseUrl: string | null; clientIdEnvVar: string | null; protocolVersion: string | null;
  };

  const updated = await prisma.$transaction(async (tx) => {
    const nextRevision = connection.configRevision + 1;
    const r = await tx.interopConnection.updateMany({
      where: { id: connection.id, version: connection.version },
      data: {
        environment: snap.environment,
        baseUrl: snap.baseUrl,
        clientIdEnvVar: snap.clientIdEnvVar,
        protocolVersion: snap.protocolVersion,
        status: snap.environment === "DISABLED" ? "NOT_CONFIGURED" : "CONFIGURED",
        enabled: false,
        productionApprovedByUserId: null,
        productionApprovedAt: null,
        productionApprovalNote: null,
        sandboxVerifiedAt: null,
        productionVerifiedAt: null,
        configRevision: nextRevision,
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ConflictError("That integration was changed concurrently.");
    const row = await tx.interopConnection.findUniqueOrThrow({ where: { id: connection.id } });
    await writeRevision(tx, {
      facilityId: input.facilityId, connectionId: row.id, revision: nextRevision,
      changeKind: "ROLLBACK", snapshot: snapshotOf(row),
      reason: `Rolled back to revision ${input.revision}. ${input.reason.trim()}`,
      changedByUserId: input.actor.userId,
    });
    return row;
  });

  await recordAuditEvent(
    "hospital.interop.configurationRolledBack",
    input.actor.userId,
    { system, toRevision: input.revision, newRevision: updated.configRevision },
    { facilityId: input.facilityId }
  );
  return updated;
}

export async function listRevisions(facilityId: string, system: string) {
  const s = assertKnownSystem(system);
  const connection = await prisma.interopConnection.findUnique({
    where: { facilityId_system: { facilityId, system: s } },
  });
  if (!connection) return [];
  return prisma.integrationConfigRevision.findMany({
    where: { connectionId: connection.id, facilityId },
    orderBy: { revision: "desc" },
    take: 100,
  });
}
