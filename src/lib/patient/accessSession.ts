import { createHash, randomInt } from "crypto";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";
import type { PatientAccessSession, PatientAccessSessionStatus, Prisma } from "@prisma/client";
import { DEFAULT_SHARE_CATEGORIES, type ShareChoice } from "@/lib/sharing/categories";
import { activateShareTx, activeLinkedPatients, createShareTx, endShareTx } from "@/lib/sharing/shares";

/**
 * Week 4c — a session's share ends with its visit (docs/CONSENT_SHARING_DESIGN.md §4.2):
 * a visit that ended or timed out ends it (VISIT_ENDED); an unredeemed code
 * that lapsed expires it; one the patient cancelled revokes it.
 */
async function endSessionShare(tx: Prisma.TransactionClient, s: { shareId: string | null }, how: "VISIT_ENDED" | "CODE_LAPSED" | "PATIENT_CANCELLED", actorUserId: string | null) {
  if (!s.shareId) return;
  if (how === "VISIT_ENDED") await endShareTx(tx, s.shareId, "ENDED", "VISIT_ENDED", actorUserId);
  else if (how === "CODE_LAPSED") await endShareTx(tx, s.shareId, "EXPIRED", "EXPIRED", actorUserId);
  else await endShareTx(tx, s.shareId, "REVOKED", "PATIENT_ENDED", actorUserId);
}

/** A code share's validity: 1–24 hours, default 24 (§4.1). */
export const SHARE_VALID_HOURS_DEFAULT = 24;

/**
 * PatientAccessSessionStatusChanged, in the writer's transaction. The tenant is
 * the facility where the access occurs: the redeeming clinician's, stored on
 * the session at redemption (batch 6, fix 3). Before redemption nothing has
 * been accessed and there is no such facility, so issuing a code, and a code
 * that lapses or is cancelled unredeemed, emit nothing (as an unaccepted
 * family invitation emits nothing).
 */
async function emitSessionStatus(
  tx: Prisma.TransactionClient, s: PatientAccessSession, from: PatientAccessSessionStatus | null,
  extra: { endedBy?: "DOCTOR" | "PATIENT" | "SYSTEM"; extended?: boolean; actorUserId?: string | null } = {},
) {
  if (!s.facilityId) return;
  await emitFacilityEvent(tx, {
    type: "PatientAccessSessionStatusChanged", aggregateId: s.id, facilityId: s.facilityId, actorUserId: extra.actorUserId ?? null,
    payload: {
      accessGrantId: s.id, patientId: s.patientId, from, to: s.status, extended: extra.extended ?? false,
      ...(extra.endedBy ? { endedBy: extra.endedBy } : {}), ...(s.doctorStaffId ? { doctorStaffId: s.doctorStaffId } : {}),
    },
  });
}

/**
 * Bedside patient-access sessions — the "give your code to the doctor" workflow.
 *
 * Lifecycle: a patient issues a short one-time CODE (PENDING). A doctor redeems
 * it (ACTIVE), reads the patient's full history for the visit, then ends it
 * (ENDED). The PatientAccessSession row is the shared workflow record linking
 * both parties with start/end times; every transition is mirrored into
 * AuditEvent for the patient AND the doctor. Only the code hash is persisted.
 */

// 8 chars, unambiguous alphabet (no 0/O/1/I) — read aloud or shown on screen.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 8;
// A freshly issued code is redeemable for this long before it must be re-issued.
const CODE_TTL_MS = 1000 * 60 * 30; // 30 minutes to hand the code over

// Once redeemed, the consult auto-logs-off after this unless the doctor
// "continues" it. 15 min ≈ a typical India OPD consultation.
export const ACTIVE_TTL_MS = 1000 * 60 * 15;
// Each "continue this session" adds this much grace before the next cutoff.
export const GRACE_EXTEND_MS = 1000 * 60 * 10;
// The client surfaces the "continue" prompt once remaining time drops below this.
export const WARN_THRESHOLD_MS = 1000 * 60 * 3;

export function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LEN; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

/** Format for display: "ABCD-EF23". */
export function prettyCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/**
 * Issue a new code for a patient. Any of the patient's still-open PENDING/ACTIVE
 * sessions are closed first so only one live grant exists at a time.
 */
export async function issueAccessCode(patientId: string, createdByUserId: string, purpose?: string, share?: { choice?: ShareChoice; validHours?: number }) {
  const now = new Date();
  const validHours = Math.min(24, Math.max(1, Math.round(share?.validHours ?? SHARE_VALID_HOURS_DEFAULT)));
  const choice: ShareChoice = share?.choice ?? { categories: [...DEFAULT_SHARE_CATEGORIES], sensitiveCategories: [], purpose: "CONSULTATION" };
  // Week 4c: every new code carries a share of the person's record. A record with no linked Person (an account the identity migration hasn't moved) keeps the pre-4c code.
  const link = await prisma.personPatientLink.findFirst({ where: { patientId, status: "ACTIVE" }, select: { personId: true } });

  // Auto-expire the patient's stale open sessions (single live grant), each with its event.
  const open = await prisma.patientAccessSession.findMany({ where: { patientId, status: { in: ["PENDING", "ACTIVE"] } } });
  for (const o of open) {
    await prisma.$transaction(async (tx) => {
      const r = await tx.patientAccessSession.updateMany({ where: { id: o.id, status: o.status }, data: { status: "EXPIRED", endedAt: now, endedBy: "SYSTEM" } });
      if (r.count === 1) {
        await emitSessionStatus(tx, await tx.patientAccessSession.findUniqueOrThrow({ where: { id: o.id } }), o.status, { endedBy: "SYSTEM", actorUserId: createdByUserId });
        await endSessionShare(tx, o, o.status === "ACTIVE" ? "VISIT_ENDED" : "CODE_LAPSED", createdByUserId);
      }
    });
  }

  // Generate a code whose hash is unique (retry on the astronomically rare clash).
  let code = generateCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await prisma.patientAccessSession.findUnique({ where: { codeHash: hashCode(code) } });
    if (!clash) break;
    code = generateCode();
  }

  const session = await prisma.$transaction(async (tx) => {
    const recordShare = link
      ? await createShareTx(tx, { personId: link.personId, kind: "CODE", status: "PENDING", choice, patientIds: await activeLinkedPatients(link.personId, tx), expiresAt: new Date(now.getTime() + validHours * 3_600_000), createdByUserId })
      : null;
    const created = await tx.patientAccessSession.create({
      data: {
        patientId,
        createdByUserId,
        shareId: recordShare?.id ?? null,
        codeHash: hashCode(code),
        status: "PENDING",
        purpose: purpose?.slice(0, 200),
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      },
    });
    await emitSessionStatus(tx, created, null, { actorUserId: createdByUserId });
    return created;
  });

  await recordAuditEvent("patient.access.codeIssued", createdByUserId, { sessionId: session.id }, { patientId });

  // Plaintext returned ONCE to the issuing patient; never stored.
  return { session, code };
}

class ShareGoneError extends Error {}

/** A doctor redeems a code. Returns the now-ACTIVE session, or null if invalid. */
export async function redeemAccessCode(opts: {
  code: string;
  doctorUserId: string;
  doctorStaffId?: string | null;
  doctorName?: string | null;
  /** The facility where the access occurs (the redeeming staff member's): the events' tenant. */
  facilityId: string;
}) {
  const now = new Date();
  const found = await prisma.patientAccessSession.findUnique({ where: { codeHash: hashCode(opts.code) } });

  // Uniform failure: bad code, already used, or expired are indistinguishable.
  if (!found || found.status !== "PENDING" || found.expiresAt < now) {
    if (found && found.status === "PENDING" && found.expiresAt < now) {
      await prisma.$transaction(async (tx) => {
        const r = await tx.patientAccessSession.updateMany({ where: { id: found.id, status: "PENDING" }, data: { status: "EXPIRED", endedAt: now, endedBy: "SYSTEM" } });
        if (r.count === 1) {
          await emitSessionStatus(tx, await tx.patientAccessSession.findUniqueOrThrow({ where: { id: found.id } }), "PENDING", { endedBy: "SYSTEM" });
          await endSessionShare(tx, found, "CODE_LAPSED", null);
        }
      });
    }
    return null;
  }

  // Guarded transition — only the row still PENDING flips to ACTIVE (race-safe).
  const session = await prisma.$transaction(async (tx) => {
    const result = await tx.patientAccessSession.updateMany({
      where: { id: found.id, status: "PENDING" },
      data: {
        status: "ACTIVE",
        doctorUserId: opts.doctorUserId,
        doctorStaffId: opts.doctorStaffId ?? undefined,
        doctorName: opts.doctorName ?? undefined,
        facilityId: opts.facilityId,
        redeemedAt: now,
        activeExpiresAt: new Date(now.getTime() + ACTIVE_TTL_MS),
      },
    });
    if (result.count === 0) return null;
    // The code's share binds to this doctor; a share the person ended (or that lapsed) refuses the redemption.
    if (found.shareId && !(await activateShareTx(tx, found.shareId, { userId: opts.doctorUserId, facilityId: opts.facilityId }))) throw new ShareGoneError();
    const active = await tx.patientAccessSession.findUniqueOrThrow({ where: { id: found.id } });
    await emitSessionStatus(tx, active, "PENDING", { actorUserId: opts.doctorUserId });
    return active;
  }).catch((err) => {
    if (err instanceof ShareGoneError) return null;
    throw err;
  });
  if (!session) return null;

  // Log the doctor opening the record — mirrored for both parties.
  await recordAuditEvent(
    "patient.access.redeemed",
    opts.doctorUserId,
    { sessionId: session.id, doctorName: opts.doctorName },
    { patientId: session.patientId, facilityId: opts.facilityId ?? undefined }
  );
  await recordAuditEvent(
    "patient.access.redeemed",
    session.createdByUserId ?? null,
    { sessionId: session.id, byDoctor: opts.doctorName },
    { patientId: session.patientId }
  );

  return session;
}

/** End an ACTIVE session (records the visit). `by` = who initiated the end. */
/**
 * The patient ends their own access (batch 7, item 5; the cancel was written
 * by the route): an unredeemed code is CANCELLED (no access occurred, so no
 * event, as for any unredeemed code); a live session is ended as by the doctor.
 */
export async function endOwnAccessSession(sessionId: string, patientId: string, actingUserId: string) {
  const existing = await prisma.patientAccessSession.findUnique({ where: { id: sessionId } });
  if (!existing || existing.patientId !== patientId) return null;
  if (existing.status === "PENDING") {
    await prisma.$transaction(async (tx) => {
      const r = await tx.patientAccessSession.updateMany({ where: { id: sessionId, status: "PENDING" }, data: { status: "CANCELLED", endedAt: new Date(), endedBy: "PATIENT" } });
      if (r.count === 1) await endSessionShare(tx, existing, "PATIENT_CANCELLED", actingUserId);
    });
    return { status: "CANCELLED" as const };
  }
  const ended = await endAccessSession(sessionId, "PATIENT", actingUserId);
  return { status: ended?.status ?? ("ENDED" as const) };
}

export async function endAccessSession(sessionId: string, by: "DOCTOR" | "PATIENT" | "SYSTEM", actingUserId: string | null) {
  const now = new Date();
  const session = await prisma.patientAccessSession.findUnique({ where: { id: sessionId } });
  if (!session || session.status !== "ACTIVE") return session ?? null;

  const ended = await prisma.$transaction(async (tx) => {
    const result = await tx.patientAccessSession.updateMany({
      where: { id: sessionId, status: "ACTIVE" },
      data: { status: "ENDED", endedAt: now, endedBy: by },
    });
    if (result.count === 0) return false;
    await emitSessionStatus(tx, await tx.patientAccessSession.findUniqueOrThrow({ where: { id: sessionId } }), "ACTIVE", { endedBy: by, actorUserId: actingUserId });
    await endSessionShare(tx, session, "VISIT_ENDED", actingUserId);
    return true;
  });
  if (!ended) return prisma.patientAccessSession.findUnique({ where: { id: sessionId } });

  const durationMin = session.redeemedAt
    ? Math.max(1, Math.round((now.getTime() - session.redeemedAt.getTime()) / 60000))
    : null;

  // The "visit" record: one ended event logged to BOTH parties' audit trails.
  const detail = {
    sessionId: session.id,
    doctorName: session.doctorName,
    endedBy: by,
    endedByUserId: actingUserId,
    durationMinutes: durationMin,
  };
  await recordAuditEvent("patient.access.ended", session.doctorUserId ?? null, detail, {
    patientId: session.patientId,
    facilityId: session.facilityId ?? undefined,
  });
  await recordAuditEvent("patient.access.ended", session.createdByUserId ?? null, detail, {
    patientId: session.patientId,
  });

  return prisma.patientAccessSession.findUnique({ where: { id: sessionId } });
}

type Session = NonNullable<Awaited<ReturnType<typeof prisma.patientAccessSession.findUnique>>>;

/**
 * Auto-log-off enforcement: if an ACTIVE session is past its activeExpiresAt,
 * flip it to EXPIRED (endedBy SYSTEM) and log the end for both parties. Returns
 * the current session so callers can re-check status. Safe to call on every read.
 */
export async function enforceActiveExpiry(session: Session): Promise<Session> {
  if (session.status !== "ACTIVE") return session;
  if (session.activeExpiresAt && session.activeExpiresAt.getTime() > Date.now()) return session;

  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const r = await tx.patientAccessSession.updateMany({
      where: { id: session.id, status: "ACTIVE" },
      data: { status: "EXPIRED", endedAt: now, endedBy: "SYSTEM" },
    });
    if (r.count > 0) {
      await emitSessionStatus(tx, await tx.patientAccessSession.findUniqueOrThrow({ where: { id: session.id } }), "ACTIVE", { endedBy: "SYSTEM" });
      await endSessionShare(tx, session, "VISIT_ENDED", null);
    }
    return r;
  });
  if (result.count > 0) {
    const detail = { sessionId: session.id, doctorName: session.doctorName, endedBy: "SYSTEM", reason: "timeout" };
    await recordAuditEvent("patient.access.ended", session.doctorUserId ?? null, detail, {
      patientId: session.patientId,
      facilityId: session.facilityId ?? undefined,
    });
    await recordAuditEvent("patient.access.ended", session.createdByUserId ?? null, detail, { patientId: session.patientId });
  }
  return (await prisma.patientAccessSession.findUnique({ where: { id: session.id } })) ?? session;
}

/**
 * "Continue this session" — the doctor extends an ACTIVE consult by
 * GRACE_EXTEND_MS. Refused if the session already expired (patient must issue a
 * new code). Returns the updated session, or null if it could not be extended.
 */
export async function extendAccessSession(sessionId: string): Promise<Session | null> {
  const session = await prisma.patientAccessSession.findUnique({ where: { id: sessionId } });
  if (!session) return null;
  // A session already past its cutoff is dead — enforce, then refuse.
  const enforced = await enforceActiveExpiry(session);
  if (enforced.status !== "ACTIVE") return null;

  const base = enforced.activeExpiresAt && enforced.activeExpiresAt.getTime() > Date.now()
    ? enforced.activeExpiresAt.getTime()
    : Date.now();
  // Week 4c: never past the share's own validity, and not at all once it ended.
  const share = enforced.shareId ? await prisma.recordShare.findUnique({ where: { id: enforced.shareId }, select: { status: true, expiresAt: true } }) : null;
  if (share && (share.status !== "ACTIVE" || share.expiresAt.getTime() <= base)) return null;
  const until = Math.min(base + GRACE_EXTEND_MS, share?.expiresAt.getTime() ?? Infinity);
  return prisma.$transaction(async (tx) => {
    const r = await tx.patientAccessSession.updateMany({
      where: { id: sessionId, status: "ACTIVE" },
      data: { activeExpiresAt: new Date(until), extensionCount: { increment: 1 } },
    });
    if (r.count !== 1) return null;
    const updated = await tx.patientAccessSession.findUniqueOrThrow({ where: { id: sessionId } });
    await emitSessionStatus(tx, updated, "ACTIVE", { extended: true, actorUserId: updated.doctorUserId });
    return updated;
  });
}
