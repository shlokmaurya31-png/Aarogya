import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitDomainEvent } from "@/lib/events/emit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

/**
 * Flagship 4e — offline mode per ward, behind the clinical advisor's sign-off
 * (docs/OFFLINE_NURSING_DESIGN.md §6, §13.5).
 *
 *   Sign-off   platform staff record the advisor's sign-off of the §6 rules
 *              (name, the document's reference, the date), or revoke it with
 *              a reason; both audited, with their events. Revoking turns
 *              offline mode off on every ward.
 *   Ward       offline mode is off until the hospital admin turns it on, and
 *              turning it on is refused while no sign-off is active. Turning
 *              it off is always allowed. While off, no pack is issued and no
 *              lease renewed; what devices already recorded still syncs (a
 *              recorded fact is never refused for this).
 */

export const OFFLINE_SIGN_OFF_SCOPE = "OFFLINE_NURSING_S6";

/** Offline mode is off for this ward (409). */
export class OfflineModeOffError extends ConflictError {
  constructor() { super("Offline mode is off for this ward. The hospital admin turns it on, once the clinical advisor has signed off the offline rules."); }
}

export async function activeSignOff(scope = OFFLINE_SIGN_OFF_SCOPE) {
  return prisma.clinicalSignOff.findFirst({ where: { scope, revokedAt: null }, select: { id: true, advisorName: true, reference: true, signedOffAt: true } });
}

export async function recordClinicalSignOff(platform: { userId: string }, body: { advisorName?: unknown; reference?: unknown; signedOffAt?: unknown }) {
  const advisorName = typeof body.advisorName === "string" ? body.advisorName.trim().slice(0, 120) : "";
  const reference = typeof body.reference === "string" ? body.reference.trim().slice(0, 200) : "";
  const signedOffAt = typeof body.signedOffAt === "string" ? new Date(body.signedOffAt) : null;
  if (!advisorName || !reference || !signedOffAt || Number.isNaN(signedOffAt.getTime()) || signedOffAt > new Date()) throw new BadRequestError("The advisor's name, the signed document's reference and the date it was signed (not in the future) are required.");
  try {
    const s = await prisma.$transaction(async (tx) => {
      const s = await tx.clinicalSignOff.create({ data: { scope: OFFLINE_SIGN_OFF_SCOPE, advisorName, reference, signedOffAt, recordedByUserId: platform.userId } });
      await emitDomainEvent(tx, { type: "ClinicalSignOffRecorded", aggregateId: s.id, actorUserId: platform.userId, payload: { signOffId: s.id, scope: s.scope } });
      return s;
    });
    await recordAuditEvent("platform.clinical-sign-off.recorded", platform.userId, { signOffId: s.id, scope: s.scope, advisorName, reference, signedOffAt: signedOffAt.toISOString() });
    return s;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") throw new ConflictError("A sign-off of these rules is already recorded; revoke it first to record another.");
    throw e;
  }
}

export async function revokeClinicalSignOff(platform: { userId: string }, signOffId: string, body: { reason?: unknown }) {
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (!reason) throw new BadRequestError("A reason is required.");
  const s = await prisma.clinicalSignOff.findUnique({ where: { id: signOffId } });
  if (!s) throw new NotFoundError("Sign-off not found.");
  if (s.revokedAt) throw new ConflictError("This sign-off has already been revoked.");
  const wards = await prisma.ward.findMany({ where: { offlineEnabled: true }, select: { id: true, facilityId: true } });
  await prisma.$transaction(async (tx) => {
    const u = await tx.clinicalSignOff.updateMany({ where: { id: s.id, revokedAt: null }, data: { revokedAt: new Date(), revokedByUserId: platform.userId, revokeReason: reason } });
    if (u.count !== 1) throw new ConflictError("This sign-off has already been revoked.");
    await emitDomainEvent(tx, { type: "ClinicalSignOffRevoked", aggregateId: s.id, actorUserId: platform.userId, payload: { signOffId: s.id, scope: s.scope, wardsTurnedOff: wards.length } });
    // Without a sign-off, no ward keeps offline mode.
    for (const w of wards) {
      const r = await tx.ward.updateMany({ where: { id: w.id, offlineEnabled: true }, data: { offlineEnabled: false, offlineEnabledAt: null, offlineEnabledByUserId: null } });
      if (r.count === 1) await emitFacilityEvent(tx, { type: "WardOfflineModeChanged", aggregateId: w.id, facilityId: w.facilityId, actorUserId: platform.userId, payload: { wardId: w.id, enabled: false, cause: "SIGN_OFF_REVOKED" } });
    }
  }, { timeout: 60_000 });
  await recordAuditEvent("platform.clinical-sign-off.revoked", platform.userId, { signOffId: s.id, reason, wardsTurnedOff: wards.length });
  return { signOffId: s.id, revoked: true, wardsTurnedOff: wards.length };
}

/** The hospital admin turns a ward's offline mode on (only with an active sign-off) or off, with a reason. */
export async function setWardOfflineMode(admin: { userId: string; facilityId: string }, wardId: string, body: { enabled?: unknown; reason?: unknown }) {
  const ward = await prisma.ward.findUnique({ where: { id: wardId }, select: { id: true, facilityId: true, offlineEnabled: true } });
  if (!ward || ward.facilityId !== admin.facilityId) throw new NotFoundError("Ward not found.");
  if (typeof body.enabled !== "boolean") throw new BadRequestError("enabled (true or false) is required.");
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (!reason) throw new BadRequestError("A reason is required.");
  const signOff = body.enabled ? await activeSignOff() : null;
  if (body.enabled && !signOff) throw new ConflictError("Offline mode can't be turned on yet: the clinical advisor's sign-off of the offline rules (design §6) is pending.");
  if (ward.offlineEnabled === body.enabled) return { wardId: ward.id, offlineEnabled: ward.offlineEnabled, changed: false };
  await prisma.$transaction(async (tx) => {
    const r = await tx.ward.updateMany({ where: { id: ward.id, offlineEnabled: !body.enabled }, data: body.enabled ? { offlineEnabled: true, offlineEnabledAt: new Date(), offlineEnabledByUserId: admin.userId } : { offlineEnabled: false, offlineEnabledAt: null, offlineEnabledByUserId: null } });
    if (r.count !== 1) throw new ConflictError("The ward changed in the meantime.");
    await emitFacilityEvent(tx, { type: "WardOfflineModeChanged", aggregateId: ward.id, facilityId: ward.facilityId, actorUserId: admin.userId, payload: { wardId: ward.id, enabled: body.enabled as boolean, cause: "HOSPITAL_ADMIN", ...(signOff ? { signOffId: signOff.id } : {}) } });
  });
  await recordAuditEvent("hospital.offline.ward-mode.changed", admin.userId, { wardId: ward.id, enabled: body.enabled, reason, ...(signOff ? { signOffId: signOff.id } : {}) }, { facilityId: ward.facilityId });
  return { wardId: ward.id, offlineEnabled: body.enabled, changed: true };
}

/** Packs and lease renewals need the ward's offline mode on. */
export async function assertWardOffline(wardId: string) {
  const w = await prisma.ward.findUnique({ where: { id: wardId }, select: { offlineEnabled: true } });
  if (!w?.offlineEnabled) throw new OfflineModeOffError();
}
