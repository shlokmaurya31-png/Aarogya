import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/**
 * Phase C6 — deterministic operational alerts.
 *
 * Every alert is raised by an explicit rule with a named condition. There is no
 * anomaly detection, no scoring and no model: an operator must be able to read
 * an alert and know exactly which rule fired and why.
 *
 * The `(facilityId, dedupeKey)` unique constraint is what stops a repeating
 * condition from flooding the list — a re-detection increments a counter on the
 * existing open alert instead of creating a second row. That is enforced by the
 * database rather than by a lookup, because these are raised concurrently from
 * request paths.
 */

export const ALERT_TYPES = [
  "CERTIFICATE_EXPIRING",
  "CERTIFICATE_EXPIRED",
  "CONFIGURATION_MISSING",
  "REPEATED_FAILURE",
  "RETRY_EXHAUSTED",
  "CALLBACK_REJECTED",
  "RECONCILIATION_MISMATCH",
  "INTEGRATION_DISABLED",
  "UNSAFE_ENVIRONMENT",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

export const ALERT_SEVERITIES = ["INFO", "WARNING", "CRITICAL"] as const;

/**
 * Raise or re-detect an alert.
 *
 * Never throws: alerting is a side effect of an operational path, and a failure
 * to record an alert must not fail the operation that noticed the condition.
 */
export async function raiseAlert(input: {
  facilityId: string;
  system: string;
  alertType: AlertType;
  dedupeKey: string;
  detail: string;
  severity?: "INFO" | "WARNING" | "CRITICAL";
  connectionId?: string | null;
}) {
  const now = new Date();
  try {
    return await prisma.integrationAlert.create({
      data: {
        facilityId: input.facilityId,
        connectionId: input.connectionId ?? null,
        system: input.system,
        alertType: input.alertType,
        severity: input.severity ?? "WARNING",
        dedupeKey: input.dedupeKey,
        detail: input.detail.slice(0, 1000),
        status: "OPEN",
        firstDetectedAt: now,
        lastDetectedAt: now,
      },
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      // Already known. Re-detection reopens a resolved alert and bumps the
      // counter — a condition that comes back is not the same as one that never
      // went away, and an operator needs to see both.
      const existing = await prisma.integrationAlert.findUnique({
        where: { facilityId_dedupeKey: { facilityId: input.facilityId, dedupeKey: input.dedupeKey } },
      });
      if (!existing) return null;
      await prisma.integrationAlert.updateMany({
        where: { id: existing.id, version: existing.version },
        data: {
          status: "OPEN",
          resolvedAt: null,
          detail: input.detail.slice(0, 1000),
          severity: input.severity ?? existing.severity,
          occurrenceCount: { increment: 1 },
          lastDetectedAt: now,
          version: { increment: 1 },
        },
      });
      return prisma.integrationAlert.findUnique({ where: { id: existing.id } });
    }
    // Anything else is swallowed on purpose. See the note above.
    return null;
  }
}

/** Resolve an alert automatically when its condition has demonstrably cleared. */
export async function resolveAlertsByType(facilityId: string, dedupeKey: string) {
  await prisma.integrationAlert.updateMany({
    where: { facilityId, dedupeKey, status: { in: ["OPEN", "ACKNOWLEDGED"] } },
    data: { status: "RESOLVED", resolvedAt: new Date(), resolutionNote: "Condition cleared.", version: { increment: 1 } },
  });
}

const ALERT_TRANSITIONS: Record<string, string[]> = {
  OPEN: ["ACKNOWLEDGED", "RESOLVED"],
  ACKNOWLEDGED: ["RESOLVED"],
  RESOLVED: [],
};

/** Operator action on an alert. Guarded, audited, and never silently reopening. */
export async function transitionAlert(input: {
  facilityId: string; alertId: string; to: "ACKNOWLEDGED" | "RESOLVED";
  note?: string; byUserId: string;
}) {
  const updated = await prisma.$transaction(async (tx) => {
    const alert = await tx.integrationAlert.findUnique({ where: { id: input.alertId } });
    if (!alert || alert.facilityId !== input.facilityId) throw new NotFoundError("Alert not found.");
    if (!ALERT_TRANSITIONS[alert.status]?.includes(input.to)) {
      throw new BadRequestError(`Illegal alert transition ${alert.status} -> ${input.to}.`);
    }
    if (input.to === "RESOLVED" && !input.note?.trim()) {
      throw new BadRequestError("A note is required to resolve an alert.");
    }
    const r = await tx.integrationAlert.updateMany({
      where: { id: alert.id, status: alert.status, version: alert.version },
      data: {
        status: input.to,
        ...(input.to === "ACKNOWLEDGED"
          ? { acknowledgedAt: new Date(), acknowledgedByUserId: input.byUserId }
          : { resolvedAt: new Date(), resolutionNote: input.note?.trim().slice(0, 500) }),
        version: { increment: 1 },
      },
    });
    if (r.count !== 1) throw new ConflictError("That alert changed concurrently.");
    return tx.integrationAlert.findUniqueOrThrow({ where: { id: alert.id } });
  });

  await recordAuditEvent(
    "hospital.interop.alertTransitioned",
    input.byUserId,
    { alertId: updated.id, alertType: updated.alertType, to: input.to },
    { facilityId: input.facilityId }
  );
  return updated;
}

export async function listAlerts(args: { facilityId: string; status?: string; system?: string }) {
  return prisma.integrationAlert.findMany({
    where: {
      facilityId: args.facilityId,
      ...(args.status ? { status: args.status } : {}),
      ...(args.system ? { system: args.system } : {}),
    },
    orderBy: [{ severity: "desc" }, { lastDetectedAt: "desc" }],
    take: 200,
  });
}
