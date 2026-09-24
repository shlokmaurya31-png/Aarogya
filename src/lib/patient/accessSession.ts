import { createHash, randomInt } from "crypto";
import { prisma } from "@/lib/db";
import { recordAuditEvent } from "@/lib/auth/audit";

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
export async function issueAccessCode(patientId: string, createdByUserId: string, purpose?: string) {
  const now = new Date();

  // Auto-expire the patient's stale open sessions (single live grant).
  await prisma.patientAccessSession.updateMany({
    where: { patientId, status: { in: ["PENDING", "ACTIVE"] } },
    data: { status: "EXPIRED", endedAt: now, endedBy: "SYSTEM" },
  });

  // Generate a code whose hash is unique (retry on the astronomically rare clash).
  let code = generateCode();
  for (let attempt = 0; attempt < 5; attempt++) {
    const clash = await prisma.patientAccessSession.findUnique({ where: { codeHash: hashCode(code) } });
    if (!clash) break;
    code = generateCode();
  }

  const session = await prisma.patientAccessSession.create({
    data: {
      patientId,
      createdByUserId,
      codeHash: hashCode(code),
      status: "PENDING",
      purpose: purpose?.slice(0, 200),
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    },
  });

  await recordAuditEvent("patient.access.codeIssued", createdByUserId, { sessionId: session.id }, { patientId });

  // Plaintext returned ONCE to the issuing patient; never stored.
  return { session, code };
}

/** A doctor redeems a code. Returns the now-ACTIVE session, or null if invalid. */
export async function redeemAccessCode(opts: {
  code: string;
  doctorUserId: string;
  doctorStaffId?: string | null;
  doctorName?: string | null;
  facilityId?: string | null;
}) {
  const now = new Date();
  const found = await prisma.patientAccessSession.findUnique({ where: { codeHash: hashCode(opts.code) } });

  // Uniform failure: bad code, already used, or expired are indistinguishable.
  if (!found || found.status !== "PENDING" || found.expiresAt < now) {
    if (found && found.status === "PENDING" && found.expiresAt < now) {
      await prisma.patientAccessSession.update({
        where: { id: found.id },
        data: { status: "EXPIRED", endedAt: now, endedBy: "SYSTEM" },
      });
    }
    return null;
  }

  // Guarded transition — only the row still PENDING flips to ACTIVE (race-safe).
  const result = await prisma.patientAccessSession.updateMany({
    where: { id: found.id, status: "PENDING" },
    data: {
      status: "ACTIVE",
      doctorUserId: opts.doctorUserId,
      doctorStaffId: opts.doctorStaffId ?? undefined,
      doctorName: opts.doctorName ?? undefined,
      facilityId: opts.facilityId ?? undefined,
      redeemedAt: now,
      activeExpiresAt: new Date(now.getTime() + ACTIVE_TTL_MS),
    },
  });
  if (result.count === 0) return null;

  const session = await prisma.patientAccessSession.findUnique({ where: { id: found.id } });
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
export async function endAccessSession(sessionId: string, by: "DOCTOR" | "PATIENT" | "SYSTEM", actingUserId: string | null) {
  const now = new Date();
  const session = await prisma.patientAccessSession.findUnique({ where: { id: sessionId } });
  if (!session || session.status !== "ACTIVE") return session ?? null;

  const result = await prisma.patientAccessSession.updateMany({
    where: { id: sessionId, status: "ACTIVE" },
    data: { status: "ENDED", endedAt: now, endedBy: by },
  });
  if (result.count === 0) return prisma.patientAccessSession.findUnique({ where: { id: sessionId } });

  const durationMin = session.redeemedAt
    ? Math.max(1, Math.round((now.getTime() - session.redeemedAt.getTime()) / 60000))
    : null;

  // The "visit" record: one ended event logged to BOTH parties' audit trails.
  const detail = {
    sessionId: session.id,
    doctorName: session.doctorName,
    endedBy: by,
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
  const result = await prisma.patientAccessSession.updateMany({
    where: { id: session.id, status: "ACTIVE" },
    data: { status: "EXPIRED", endedAt: now, endedBy: "SYSTEM" },
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
  const updated = await prisma.patientAccessSession.update({
    where: { id: sessionId },
    data: { activeExpiresAt: new Date(base + GRACE_EXTEND_MS), extensionCount: { increment: 1 } },
  });
  return updated;
}

/**
 * The patient's full longitudinal history for an ACTIVE session. Access is
 * gated by the session itself (the code IS the consent) — not by facility — so
 * it works for any clinician the patient chose to share with.
 */
export async function getSessionHistory(patientId: string) {
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    include: {
      allergies: { orderBy: { recordedAt: "desc" } },
      problems: { orderBy: { createdAt: "desc" } },
      diagnoses: { orderBy: { createdAt: "desc" }, take: 50 },
      encounters: {
        orderBy: { registeredAt: "desc" },
        take: 30,
        include: {
          department: true,
          attendingStaff: { include: { user: true } },
        },
      },
      medicationOrders: { orderBy: { orderedAt: "desc" }, take: 50 },
    },
  });
  if (!patient) return null;

  const encounterIds = patient.encounters.map((e) => e.id);
  const [vitals, labResults] = await Promise.all([
    prisma.vital.findMany({
      where: { encounterId: { in: encounterIds } },
      orderBy: { recordedAt: "desc" },
      take: 40,
    }),
    prisma.labResult.findMany({
      where: { labOrder: { encounterId: { in: encounterIds } } },
      orderBy: { resultedAt: "desc" },
      take: 40,
      include: { catalogTest: true, labOrder: { include: { catalogTest: true } } },
    }),
  ]);

  return { patient, vitals, labResults };
}
