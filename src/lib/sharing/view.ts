import { prisma } from "@/lib/db";
import { NotFoundError } from "@/lib/auth/rbac";
import { logRecordAccess, type AccessSurface } from "./accessLog";
import { shareHistory } from "./history";
import { resolveShare, type ShareActor } from "./resolve";

/**
 * Week 4c — the shared record as a doctor sees it (the consult view, and an
 * approved request's view): resolved on every request, scoped by the share,
 * and the first opening written to the person's access log (refreshes aren't).
 * Anything the caller can't read through this share is a 404.
 */
export async function viewSharedRecord(actor: ShareActor, ref: string, surface: AccessSurface) {
  const scope = await resolveShare(actor, ref);
  if (!scope) throw new NotFoundError();
  const history = await shareHistory(scope);
  if (!history) throw new NotFoundError();
  // A code from before 4c has no share; its record's person (if linked) still sees the access.
  const pid = scope.personId ?? (await prisma.personPatientLink.findFirst({ where: { patientId: scope.subjectPatientId, status: "ACTIVE" }, select: { personId: true } }))?.personId;
  if (pid) await logRecordAccess({ personId: pid, actorUserId: actor.userId, facilityId: actor.facilityId, via: scope.via, surface, shareId: scope.shareId ?? scope.ref, categories: scope.categories, oncePerShare: true });
  return { scope, history };
}
