import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError, ConflictError } from "../rbac";
import { recordAuditEvent } from "../audit";

/**
 * Phase C4 — break-glass emergency access.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT BREAK-GLASS IS, AND WHAT IT IS NOT
 *
 * IS:  a time-boxed, reasoned, heavily audited relaxation of ONE policy — the
 *      care-relationship requirement — for ONE patient, by ONE actor.
 *
 * IS NOT: an admin bypass, a role, a permission, or a way around any of:
 *      authentication, facility isolation, patient existence, consent for
 *      external disclosure, maker/checker, or audit.
 *
 * Three properties stop it becoming a backdoor:
 *
 *   1. IT EXPIRES. There is a hard ceiling and expiry is derived from the
 *      timestamp at read time, so an unswept row cannot outlive its window.
 *   2. IT IS NARROW. Bound to one actor and one patient. A colleague cannot
 *      ride on someone else's window.
 *   3. IT IS EXPENSIVE TO USE. A meaningful reason is mandatory, every use is
 *      counted, and every activation is visible in the abuse report.
 *
 * Crucially, `breakGlassAllowed` is FALSE on every disclosure action. An
 * emergency justifies reading a chart; it does not justify transmitting a
 * record to a third party without the patient's agreement.
 * ════════════════════════════════════════════════════════════════════════════
 */

/** Declared clinical justifications. A closed set — free text is the reason, not the context. */
export const EMERGENCY_CONTEXTS = [
  "LIFE_THREATENING",
  "UNCONSCIOUS_PATIENT",
  "MASS_CASUALTY",
  "URGENT_TRANSFER",
  "CLINICAL_HANDOVER",
  "OTHER_URGENT",
] as const;
export type EmergencyContext = (typeof EMERGENCY_CONTEXTS)[number];

export const BREAK_GLASS_STATUSES = ["ACTIVE", "EXPIRED", "REVOKED", "COMPLETED"] as const;

/** A reason shorter than this is not a reason. */
export const MIN_REASON_LENGTH = 20;
export const MAX_REASON_LENGTH = 1000;

/** Hard ceiling. There is deliberately no way to request longer. */
export const MAX_DURATION_MS = 4 * 60 * 60_000;
export const DEFAULT_DURATION_MS = 60 * 60_000;

export interface ActivateBreakGlassInput {
  facilityId: string;
  patientId: string;
  encounterId?: string | null;
  /** Derived from the session by the caller. Never accepted from a client. */
  actorUserId: string;
  actorStaffId?: string | null;
  reason: string;
  emergencyContext: string;
  durationMs?: number;
}

/**
 * Activate an emergency access window.
 *
 * Facility ownership of the patient is proven BEFORE anything is written, so
 * break-glass can never be used to reach across a tenant boundary — the one
 * thing it must never be able to do.
 */
export async function activateBreakGlass(input: ActivateBreakGlassInput) {
  const reason = (input.reason ?? "").trim();
  if (reason.length < MIN_REASON_LENGTH) {
    throw new BadRequestError(
      `An emergency access reason of at least ${MIN_REASON_LENGTH} characters is required.`
    );
  }
  if (reason.length > MAX_REASON_LENGTH) {
    throw new BadRequestError("Emergency access reason is too long.");
  }
  if (!(EMERGENCY_CONTEXTS as readonly string[]).includes(input.emergencyContext)) {
    throw new BadRequestError(
      `emergencyContext must be one of ${EMERGENCY_CONTEXTS.join(", ")}.`
    );
  }

  const patient = await prisma.patient.findUnique({
    where: { id: input.patientId },
    select: { id: true, facilityId: true },
  });
  // Not-found shaped: break-glass must not reveal that a patient exists
  // elsewhere any more than ordinary access does.
  if (!patient || patient.facilityId !== input.facilityId) {
    throw new NotFoundError("Patient not found.");
  }

  if (input.encounterId) {
    const encounter = await prisma.encounter.findUnique({
      where: { id: input.encounterId },
      select: { patientId: true, facilityId: true },
    });
    if (!encounter || encounter.facilityId !== input.facilityId || encounter.patientId !== input.patientId) {
      throw new BadRequestError("That encounter does not belong to this patient in this facility.");
    }
  }

  const duration = Math.min(input.durationMs ?? DEFAULT_DURATION_MS, MAX_DURATION_MS);
  if (duration <= 0) throw new BadRequestError("Emergency access duration must be positive.");

  const correlationId = randomUUID();
  const window = await prisma.breakGlassAccess.create({
    data: {
      facilityId: input.facilityId,
      patientId: input.patientId,
      encounterId: input.encounterId ?? null,
      actorUserId: input.actorUserId,
      actorStaffId: input.actorStaffId ?? null,
      reason,
      emergencyContext: input.emergencyContext,
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + duration),
      correlationId,
    },
  });

  await recordAuditEvent(
    "security.breakGlass.activated",
    input.actorUserId,
    {
      breakGlassId: window.id,
      correlationId,
      emergencyContext: input.emergencyContext,
      // The reason IS recorded: it is the accountability record, and it is
      // operator-authored text about a clinical situation, not patient data.
      reason,
      expiresAt: window.expiresAt.toISOString(),
      encounterId: input.encounterId ?? null,
    },
    { facilityId: input.facilityId, patientId: input.patientId }
  );
  return window;
}

/** Close a window early once the emergency has passed. */
export async function completeBreakGlass(input: {
  facilityId: string; breakGlassId: string; actorUserId: string;
}) {
  return transitionWindow({
    ...input, to: "COMPLETED",
    audit: "security.breakGlass.completed",
    requireOwner: true,
  });
}

/** Administrative revocation — used when a window was activated inappropriately. */
export async function revokeBreakGlass(input: {
  facilityId: string; breakGlassId: string; actorUserId: string; reason?: string;
}) {
  return transitionWindow({
    ...input, to: "REVOKED",
    audit: "security.breakGlass.revoked",
    requireOwner: false,
  });
}

async function transitionWindow(input: {
  facilityId: string; breakGlassId: string; actorUserId: string;
  to: "COMPLETED" | "REVOKED"; audit: Parameters<typeof recordAuditEvent>[0];
  requireOwner: boolean; reason?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const window = await tx.breakGlassAccess.findUnique({ where: { id: input.breakGlassId } });
    if (!window || window.facilityId !== input.facilityId) throw new NotFoundError("Emergency access not found.");
    if (input.requireOwner && window.actorUserId !== input.actorUserId) {
      throw new NotFoundError("Emergency access not found.");
    }

    // Guarded on ACTIVE: two concurrent closes cannot both win, and a window
    // that already expired is not re-closed into a different terminal state.
    const r = await tx.breakGlassAccess.updateMany({
      where: { id: window.id, status: "ACTIVE", version: window.version },
      data: {
        status: input.to,
        version: { increment: 1 },
        ...(input.to === "COMPLETED"
          ? { completedAt: new Date() }
          : { revokedAt: new Date(), revokedByUserId: input.actorUserId, revokedReason: input.reason ?? null }),
      },
    });
    if (r.count !== 1) throw new ConflictError("That emergency access window is no longer active.");

    await tx.auditEvent.create({
      data: {
        type: input.audit,
        userId: input.actorUserId,
        detail: { breakGlassId: window.id, correlationId: window.correlationId, reason: input.reason ?? null },
        facilityId: window.facilityId,
        patientId: window.patientId,
      },
    });
    return tx.breakGlassAccess.findUniqueOrThrow({ where: { id: window.id } });
  });
}

/**
 * Sweep lapsed windows to EXPIRED.
 *
 * Purely cosmetic: the engine derives expiry from `expiresAt` at read time, so
 * an unswept row is already unusable. This only keeps the operator view tidy
 * and is safe to never run.
 */
export async function expireLapsedBreakGlass(facilityId: string, now = new Date()) {
  const result = await prisma.breakGlassAccess.updateMany({
    where: { facilityId, status: "ACTIVE", expiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });
  return { expired: result.count };
}

export async function listBreakGlass(args: { facilityId: string; status?: string; patientId?: string }) {
  return prisma.breakGlassAccess.findMany({
    where: {
      facilityId: args.facilityId,
      ...(args.status ? { status: args.status } : {}),
      ...(args.patientId ? { patientId: args.patientId } : {}),
    },
    orderBy: { activatedAt: "desc" },
    take: 200,
  });
}

/**
 * Deterministic abuse report. Counting and thresholds only — no anomaly
 * detection, no scoring, nothing that could be mistaken for a judgement.
 */
export async function breakGlassAbuseReport(facilityId: string, sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 86400_000);
  const windows = await prisma.breakGlassAccess.findMany({
    where: { facilityId, activatedAt: { gte: since } },
    select: {
      actorUserId: true, patientId: true, status: true, useCount: true,
      activatedAt: true, expiresAt: true,
    },
  });

  const byActor = new Map<string, number>();
  const byPatient = new Map<string, number>();
  for (const w of windows) {
    byActor.set(w.actorUserId, (byActor.get(w.actorUserId) ?? 0) + 1);
    byPatient.set(w.patientId, (byPatient.get(w.patientId) ?? 0) + 1);
  }

  const now = Date.now();
  return {
    windowDays: sinceDays,
    total: windows.length,
    active: windows.filter((w) => w.status === "ACTIVE" && w.expiresAt.getTime() > now).length,
    // Still marked ACTIVE but past expiry: unusable, but worth surfacing.
    lapsed: windows.filter((w) => w.status === "ACTIVE" && w.expiresAt.getTime() <= now).length,
    revoked: windows.filter((w) => w.status === "REVOKED").length,
    unused: windows.filter((w) => w.useCount === 0).length,
    topActors: [...byActor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([actorUserId, count]) => ({ actorUserId, count })),
    repeatedPatients: [...byPatient.entries()].filter(([, c]) => c > 1)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([patientId, count]) => ({ patientId, count })),
  };
}
