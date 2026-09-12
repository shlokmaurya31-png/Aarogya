import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import type { AuthorizationActor } from "@/lib/auth/authorize/types";
import { assertKnownSystem } from "./registry";
import { raiseAlert, resolveAlertsByType } from "./alerts";

/**
 * Phase C6 — certificate lifecycle.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THIS MODULE NEVER HOLDS KEY MATERIAL.
 *
 * It records WHERE a certificate lives (an environment-variable name or a
 * secret-manager reference) and the public descriptive fields needed to answer
 * "is it valid and when does it expire". It does not read the file, does not
 * accept a PEM body, and has no function that returns one.
 *
 * Rotation is MODELLED, not performed. A CURRENT and a NEXT certificate can be
 * registered with an activation time, and `activateNextCertificate` promotes
 * the record. It does not reach into a keystore, restart a process or touch a
 * live gateway — doing any of that without real infrastructure would be
 * fabricating a rotation that did not happen.
 * ════════════════════════════════════════════════════════════════════════════
 */

export const CERTIFICATE_USAGES = ["SIGNING", "TLS_CLIENT", "ENCRYPTION"] as const;
/**
 * The two LIVE slots. Retirement is represented by a null role rather than a
 * third value, so any number of retired certificates can accumulate as history
 * while the unique key still guarantees one CURRENT and one NEXT per usage.
 */
export const CERTIFICATE_ROLES = ["CURRENT", "NEXT"] as const;
export const CERTIFICATE_STATUSES = ["NOT_CONFIGURED", "VALID", "EXPIRING", "EXPIRED", "INVALID"] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

/** How long before `notAfter` a certificate starts reporting EXPIRING. */
export const EXPIRY_WARNING_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Derive status from dates. Pure, so the same rule is used by the UI, the alert
 * sweep and the tests, and cannot drift between them.
 */
export function deriveCertificateStatus(
  cert: { notBefore: Date | null; notAfter: Date | null; materialRef: string | null },
  now = new Date()
): CertificateStatus {
  if (!cert.materialRef) return "NOT_CONFIGURED";
  if (!cert.notAfter) {
    // A reference with no parsed metadata is configured but unproven. It is not
    // VALID — claiming validity for something never inspected is exactly the
    // kind of unearned label this phase forbids.
    return "INVALID";
  }
  if (cert.notBefore && cert.notBefore.getTime() > now.getTime()) return "INVALID";
  const remaining = cert.notAfter.getTime() - now.getTime();
  if (remaining <= 0) return "EXPIRED";
  if (remaining <= EXPIRY_WARNING_MS) return "EXPIRING";
  return "VALID";
}

/**
 * A hard guard on what may be written. Anything resembling key or certificate
 * material is refused outright rather than stored and redacted later.
 */
function assertSafeMetadata(input: Record<string, unknown>) {
  for (const [k, v] of Object.entries(input)) {
    if (typeof v !== "string") continue;
    if (/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE|PUBLIC KEY)-----/.test(v)) {
      throw new BadRequestError(
        `Certificate or key material must never be submitted (field: ${k}). Provide a reference to where it is stored instead.`
      );
    }
  }
}

export async function registerCertificate(input: {
  facilityId: string;
  system: string;
  actor: AuthorizationActor;
  usage: string;
  role?: string;
  materialRef: string;
  subject?: string | null;
  issuer?: string | null;
  serial?: string | null;
  fingerprint?: string | null;
  notBefore?: Date | null;
  notAfter?: Date | null;
  activatesAt?: Date | null;
}) {
  const system = assertKnownSystem(input.system);
  assertSafeMetadata(input as unknown as Record<string, unknown>);

  if (!(CERTIFICATE_USAGES as readonly string[]).includes(input.usage)) {
    throw new BadRequestError(`usage must be one of ${CERTIFICATE_USAGES.join(", ")}.`);
  }
  const role = input.role ?? "CURRENT";
  if (!(CERTIFICATE_ROLES as readonly string[]).includes(role)) {
    throw new BadRequestError(`role must be one of ${CERTIFICATE_ROLES.join(", ")}.`);
  }
  if (!input.materialRef?.trim()) {
    throw new BadRequestError("A reference to where the certificate is stored is required.");
  }
  if (input.notBefore && input.notAfter && input.notBefore >= input.notAfter) {
    throw new BadRequestError("notBefore must precede notAfter.");
  }

  const connection = await prisma.interopConnection.findUnique({
    where: { facilityId_system: { facilityId: input.facilityId, system } },
  });
  if (!connection) throw new NotFoundError("Integration not found.");

  const status = deriveCertificateStatus({
    notBefore: input.notBefore ?? null,
    notAfter: input.notAfter ?? null,
    materialRef: input.materialRef,
  });

  const cert = await prisma.integrationCertificate.upsert({
    where: { connectionId_usage_role: { connectionId: connection.id, usage: input.usage, role } },
    create: {
      facilityId: input.facilityId,
      connectionId: connection.id,
      usage: input.usage,
      role,
      status,
      materialRef: input.materialRef.trim().slice(0, 500),
      subject: input.subject?.slice(0, 300) ?? null,
      issuer: input.issuer?.slice(0, 300) ?? null,
      serial: input.serial?.slice(0, 128) ?? null,
      fingerprint: input.fingerprint?.slice(0, 128) ?? null,
      notBefore: input.notBefore ?? null,
      notAfter: input.notAfter ?? null,
      activatesAt: input.activatesAt ?? null,
      lastCheckedAt: new Date(),
    },
    update: {
      status,
      materialRef: input.materialRef.trim().slice(0, 500),
      subject: input.subject?.slice(0, 300) ?? null,
      issuer: input.issuer?.slice(0, 300) ?? null,
      serial: input.serial?.slice(0, 128) ?? null,
      fingerprint: input.fingerprint?.slice(0, 128) ?? null,
      notBefore: input.notBefore ?? null,
      notAfter: input.notAfter ?? null,
      activatesAt: input.activatesAt ?? null,
      lastCheckedAt: new Date(),
      version: { increment: 1 },
    },
  });

  await recordAuditEvent(
    "hospital.interop.certificateRegistered",
    input.actor.userId,
    // Fingerprint and serial are public identifiers, safe to audit. No subject
    // of the key material itself is recorded beyond these.
    { system, usage: input.usage, role, status, fingerprint: cert.fingerprint, notAfter: cert.notAfter },
    { facilityId: input.facilityId }
  );
  return cert;
}

/**
 * Promote the registered NEXT certificate to CURRENT.
 *
 * This updates Aarogya's RECORD of which certificate is in use. It does not
 * install anything: the operator is responsible for the corresponding change in
 * the deployment's secret store, and the runbook says so. Refusing to pretend
 * otherwise is the point.
 */
export async function activateNextCertificate(input: {
  facilityId: string; system: string; usage: string; actor: AuthorizationActor;
}) {
  const system = assertKnownSystem(input.system);
  const connection = await prisma.interopConnection.findUnique({
    where: { facilityId_system: { facilityId: input.facilityId, system } },
  });
  if (!connection) throw new NotFoundError("Integration not found.");

  const next = await prisma.integrationCertificate.findUnique({
    where: { connectionId_usage_role: { connectionId: connection.id, usage: input.usage, role: "NEXT" } },
  });
  if (!next) throw new NotFoundError("No NEXT certificate is registered for that usage.");
  if (next.activatesAt && next.activatesAt.getTime() > Date.now()) {
    throw new BadRequestError(`That certificate is not scheduled to activate until ${next.activatesAt.toISOString()}.`);
  }
  const nextStatus = deriveCertificateStatus(next);
  if (nextStatus === "EXPIRED" || nextStatus === "INVALID") {
    throw new BadRequestError(`The NEXT certificate is ${nextStatus} and cannot be activated.`);
  }

  const result = await prisma.$transaction(async (tx) => {
    // Claim the promotion by vacating the NEXT slot, guarded on the row still
    // being NEXT at the version we read. Exactly one concurrent activation can
    // win this; the rest see count 0 and abort without touching anything.
    const claimed = await tx.integrationCertificate.updateMany({
      where: { id: next.id, role: "NEXT", version: next.version },
      data: { role: null, version: { increment: 1 } },
    });
    if (claimed.count !== 1) throw new ConflictError("That certificate was activated concurrently.");

    // Free the CURRENT slot. The old certificate is RETIRED, never deleted — it
    // keeps its metadata as history and simply stops occupying a live slot.
    const current = await tx.integrationCertificate.findUnique({
      where: { connectionId_usage_role: { connectionId: connection.id, usage: input.usage, role: "CURRENT" } },
    });
    if (current) {
      await tx.integrationCertificate.update({
        where: { id: current.id },
        data: { role: null, retiredAt: new Date(), version: { increment: 1 } },
      });
    }

    return tx.integrationCertificate.update({
      where: { id: next.id },
      data: { role: "CURRENT", status: nextStatus, activatesAt: null, version: { increment: 1 } },
    });
  });

  await recordAuditEvent(
    "hospital.interop.certificateActivated",
    input.actor.userId,
    { system, usage: input.usage, fingerprint: result.fingerprint, notAfter: result.notAfter },
    { facilityId: input.facilityId }
  );
  return result;
}

/**
 * Re-derive every certificate's status and raise or clear expiry alerts.
 * Deterministic and idempotent — safe to run on every control-plane load.
 */
export async function sweepCertificates(facilityId: string, now = new Date()) {
  // Retired certificates are skipped: an expired certificate that is no longer
  // in a live slot is history, not an operational problem.
  const certs = await prisma.integrationCertificate.findMany({
    where: { facilityId, role: { in: ["CURRENT", "NEXT"] } },
    include: { connection: { select: { system: true, id: true } } },
  });

  const summary = { checked: certs.length, expiring: 0, expired: 0, invalid: 0 };

  for (const cert of certs) {
    const status = deriveCertificateStatus(cert, now);
    if (status !== cert.status) {
      await prisma.integrationCertificate.updateMany({
        where: { id: cert.id, version: cert.version },
        data: { status, lastCheckedAt: now, version: { increment: 1 } },
      });
    }
    const dedupeKey = `${cert.connection.system}:CERT:${cert.usage}:${cert.role}`;
    if (status === "EXPIRED") {
      summary.expired += 1;
      await raiseAlert({
        facilityId, system: cert.connection.system, connectionId: cert.connection.id,
        alertType: "CERTIFICATE_EXPIRED", severity: "CRITICAL", dedupeKey,
        detail: `The ${cert.role} ${cert.usage} certificate expired on ${cert.notAfter?.toISOString() ?? "an unknown date"}.`,
      });
    } else if (status === "EXPIRING") {
      summary.expiring += 1;
      await raiseAlert({
        facilityId, system: cert.connection.system, connectionId: cert.connection.id,
        alertType: "CERTIFICATE_EXPIRING", severity: "WARNING", dedupeKey,
        detail: `The ${cert.role} ${cert.usage} certificate expires on ${cert.notAfter?.toISOString() ?? "an unknown date"}.`,
      });
    } else if (status === "INVALID") {
      summary.invalid += 1;
    } else {
      await resolveAlertsByType(facilityId, dedupeKey);
    }
  }
  return summary;
}

/**
 * Certificates for the UI. `materialRef` is deliberately reduced to a boolean:
 * even a path can disclose deployment layout, and an operator only needs to
 * know whether one is set.
 */
export async function listCertificates(facilityId: string, system?: string) {
  const certs = await prisma.integrationCertificate.findMany({
    where: { facilityId, ...(system ? { connection: { system } } : {}) },
    include: { connection: { select: { system: true } } },
    orderBy: [{ usage: "asc" }, { role: "asc" }],
  });
  return certs.map((c) => ({
    id: c.id,
    system: c.connection.system,
    usage: c.usage,
    role: c.role ?? "RETIRED",
    status: c.status,
    materialConfigured: !!c.materialRef,
    subject: c.subject,
    issuer: c.issuer,
    serial: c.serial,
    fingerprint: c.fingerprint,
    notBefore: c.notBefore,
    notAfter: c.notAfter,
    activatesAt: c.activatesAt,
    lastCheckedAt: c.lastCheckedAt,
  }));
}
