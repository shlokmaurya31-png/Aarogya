import type { RagSensitiveCategory, RecordShare, ShareCategory } from "@prisma/client";
import { staffIsSubject } from "@/lib/doctors/self";
import { prisma } from "@/lib/db";
import { careRelationship } from "@/lib/person/access";
import { resolvePatientIdsForRead } from "@/lib/patient/merge";
import { enforceActiveExpiry } from "@/lib/patient/accessSession";
import { LEGACY_CODE_CATEGORIES } from "./categories";
import type { AccessVia } from "./accessLog";

/**
 * Week 4c — the one place a share becomes a scope (docs/CONSENT_SHARING_DESIGN.md §8).
 * `ref` is a code session's id (what the consult view and its AI panel hold)
 * or an approved request's share id. Null unless the share is live for THIS
 * caller, on every call:
 *   - a code: the session is ACTIVE (its consult window open), redeemed by
 *     this doctor, and its share ACTIVE and unexpired;
 *   - a request: the share is ACTIVE and unexpired, and the caller is its
 *     recipient doctor (the one who asked) at the facility it was approved
 *     for; for a facility request, also only while that facility has an
 *     active care relationship with the person (4c answer, §15);
 *   - a booking (Week 5a): the share is ACTIVE, inside [validFrom, expiresAt),
 *     and the caller is its doctor at the booked facility;
 *   - the person's account is ACTIVE;
 *   - the caller isn't reading their own record (a doctor who is also the
 *     patient: src/lib/doctors/self.ts), whatever the share says.
 * A code issued before 4c has no share: it reads under the legacy code
 * scope (the four record categories, no uploads, nothing sensitive; §4.3).
 */
export interface ShareScope {
  ref: string;
  shareId: string | null;
  sessionId: string | null;
  via: Extract<AccessVia, "SHARE_CODE" | "ACCESS_REQUEST" | "BOOKING">;
  legacy: boolean;
  personId: string | null;
  /** The record the requester knows (a code: the issuing record; a request: the requester's own). */
  subjectPatientId: string;
  /** Merge-aware ids of every record covered, and their facilities. */
  patientIds: string[];
  facilityIds: string[];
  categories: ShareCategory[];
  sensitive: RagSensitiveCategory[];
  recordedFrom: Date | null;
  recordedTo: Date | null;
  expiresAt: Date | null;
}

export interface ShareActor { userId: string; facilityId: string; role: string }

async function expand(patientIds: string[]): Promise<{ patientIds: string[]; facilityIds: string[] }> {
  const ids = [...new Set((await Promise.all(patientIds.map((p) => resolvePatientIdsForRead(p)))).flat())];
  const facilityIds = [...new Set((await prisma.patient.findMany({ where: { id: { in: ids } }, select: { facilityId: true } })).map((p) => p.facilityId))];
  return { patientIds: ids, facilityIds };
}

const personActive = async (personId: string) => (await prisma.person.findUnique({ where: { id: personId }, select: { status: true } }))?.status === "ACTIVE";

export async function resolveShare(actor: ShareActor, ref: string): Promise<ShareScope | null> {
  if (!ref || ref.length > 64) return null;
  const now = new Date();
  const session = await prisma.patientAccessSession.findUnique({ where: { id: ref } });
  if (session) {
    if (session.doctorUserId !== actor.userId) return null;
    const live = await enforceActiveExpiry(session);
    if (live.status !== "ACTIVE") return null;
    if (!live.shareId) {
      return { ref, shareId: null, sessionId: live.id, via: "SHARE_CODE", legacy: true, personId: null, subjectPatientId: live.patientId, ...(await expand([live.patientId])), categories: [...LEGACY_CODE_CATEGORIES], sensitive: [], recordedFrom: null, recordedTo: null, expiresAt: live.activeExpiresAt };
    }
    const share = await prisma.recordShare.findUnique({ where: { id: live.shareId } });
    if (!share || share.status !== "ACTIVE" || share.expiresAt <= now || share.recipientUserId !== actor.userId || !(await personActive(share.personId))) return null;
    if (await staffIsSubject(actor.userId, share.personId)) return null;
    return { ref, shareId: share.id, sessionId: live.id, via: "SHARE_CODE", legacy: false, personId: share.personId, subjectPatientId: live.patientId, ...(await expand(share.patientIds)), categories: share.categories, sensitive: share.sensitiveCategories, recordedFrom: share.recordedFrom, recordedTo: share.recordedTo, expiresAt: share.expiresAt };
  }
  const share = await prisma.recordShare.findUnique({ where: { id: ref } });
  if (share?.kind === "BOOKING") return resolveBooking(actor, ref, share, now);
  if (!share || share.kind !== "REQUEST" || share.status !== "ACTIVE" || share.expiresAt <= now || !share.accessRequestId) return null;
  if (actor.role !== "DOCTOR" || share.recipientFacilityId !== actor.facilityId) return null;
  const request = await prisma.accessRequest.findUnique({ where: { id: share.accessRequestId }, select: { patientId: true, requesterKind: true } });
  if (!request) return null;
  // Only the doctor who asked; a share with no named doctor reads for no one.
  if (!share.recipientUserId || share.recipientUserId !== actor.userId) return null;
  if (request.requesterKind === "FACILITY") {
    // A facility request: also only while the facility treats the person.
    const here = (await prisma.patient.findMany({ where: { id: { in: share.patientIds }, facilityId: actor.facilityId }, select: { id: true } })).map((p) => p.id);
    let treating = false;
    for (const p of here) if ((await careRelationship(actor.facilityId, p)).active) { treating = true; break; }
    if (!treating) return null;
  }
  if (!(await personActive(share.personId))) return null;
  if (await staffIsSubject(actor.userId, share.personId)) return null;
  return { ref, shareId: share.id, sessionId: null, via: "ACCESS_REQUEST", legacy: false, personId: share.personId, subjectPatientId: request.patientId, ...(await expand(share.patientIds)), categories: share.categories, sensitive: share.sensitiveCategories, recordedFrom: share.recordedFrom, recordedTo: share.recordedTo, expiresAt: share.expiresAt };
}

/** Week 5a: a directory booking's share, for its doctor at the booked facility, inside its window. */
async function resolveBooking(actor: ShareActor, ref: string, share: RecordShare, now: Date): Promise<ShareScope | null> {
  if (share.status !== "ACTIVE" || share.expiresAt <= now || (share.validFrom && share.validFrom > now)) return null;
  if (actor.role !== "DOCTOR" || share.recipientUserId !== actor.userId || share.recipientFacilityId !== actor.facilityId) return null;
  const booking = await prisma.directoryBooking.findUnique({ where: { shareId: share.id }, select: { appointmentId: true } });
  const appt = booking ? await prisma.appointment.findUnique({ where: { id: booking.appointmentId }, select: { patientId: true, facilityId: true } }) : null;
  if (!appt || appt.facilityId !== actor.facilityId) return null;
  if (!(await personActive(share.personId)) || (await staffIsSubject(actor.userId, share.personId))) return null;
  return { ref, shareId: share.id, sessionId: null, via: "BOOKING", legacy: false, personId: share.personId, subjectPatientId: appt.patientId, ...(await expand(share.patientIds)), categories: share.categories, sensitive: share.sensitiveCategories, recordedFrom: share.recordedFrom, recordedTo: share.recordedTo, expiresAt: share.expiresAt };
}
