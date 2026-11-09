import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";
import { emitFacilityEvent } from "@/lib/events/facilityEvent";

/**
 * Flagship 3d — the review queue for re-imported patients whose details
 * differ (docs/LEGACY_IMPORT_DESIGN.md §10.9). Nothing is applied by the
 * import: the hospital admin accepts the incoming details or keeps the
 * existing ones, with a reason; both are audited and emit
 * LegacyPatientReviewDecided. Accepting changes only the fields that differed,
 * and only while the patient still has the details the review was made
 * against (otherwise 409: someone changed them since).
 */

type Details = { fullName: string; sex: string; dob: string | null; phone: string | null };
const FIELDS = ["fullName", "sex", "dob", "phone"] as const;

export async function listPatientReviews(facilityId: string, opts: { status?: "OPEN" | "ACCEPTED" | "KEPT" } = {}) {
  const status = opts.status ?? "OPEN";
  const reviews = await prisma.legacyPatientReview.findMany({
    where: { facilityId, status },
    // Open: oldest first (a queue). Decided: the latest decisions first.
    orderBy: status === "OPEN" ? [{ createdAt: "asc" }, { id: "asc" }] : [{ decidedAt: "desc" }, { id: "desc" }],
    take: 100,
    select: { id: true, batchId: true, sourceSystem: true, sourceKey: true, patientId: true, incoming: true, existing: true, differences: true, status: true, createdAt: true, decidedAt: true, decidedByUserId: true, decisionReason: true },
  });
  // Flagship 4a: the screen shows each patient's UHID and current name, and who decided.
  const patients = new Map((await prisma.patient.findMany({ where: { facilityId, id: { in: reviews.map((r) => r.patientId) } }, select: { id: true, uhid: true, fullName: true } })).map((p) => [p.id, p]));
  const deciders = new Map((await prisma.user.findMany({ where: { id: { in: reviews.flatMap((r) => (r.decidedByUserId ? [r.decidedByUserId] : [])) } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
  return reviews.map(({ decidedByUserId, ...r }) => {
    const p = patients.get(r.patientId);
    return { ...r, patient: p ? { uhid: p.uhid, name: p.fullName } : null, decidedBy: decidedByUserId ? deciders.get(decidedByUserId) ?? null : null };
  });
}

export async function decidePatientReview(admin: { userId: string; facilityId: string }, reviewId: string, body: { decision?: unknown; reason?: unknown }) {
  const decision = body.decision === "ACCEPT" ? "ACCEPTED" : body.decision === "KEEP" ? "KEPT" : null;
  if (!decision) throw new BadRequestError("decision must be ACCEPT (the incoming details) or KEEP (the existing ones).");
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
  if (!reason) throw new BadRequestError("A reason is required.");
  const r = await prisma.legacyPatientReview.findUnique({ where: { id: reviewId } });
  if (!r || r.facilityId !== admin.facilityId) throw new NotFoundError("Review not found.");
  if (r.status !== "OPEN") throw new ConflictError("This review has already been decided.");
  const incoming = r.incoming as Details;
  const existing = r.existing as Details;
  const fields = FIELDS.filter((f) => r.differences.includes(f));

  const done = await prisma.$transaction(async (tx) => {
    const u = await tx.legacyPatientReview.updateMany({ where: { id: r.id, status: "OPEN" }, data: { status: decision, decidedByUserId: admin.userId, decidedAt: new Date(), decisionReason: reason } });
    if (u.count !== 1) throw new ConflictError("This review has already been decided.");
    if (decision === "ACCEPTED") {
      // Only while the patient still has the details the review was made against.
      const asNow: Prisma.PatientWhereInput = { id: r.patientId, facilityId: admin.facilityId };
      const data: Prisma.PatientUpdateManyMutationInput = {};
      for (const f of fields) {
        if (f === "dob") { asNow.dob = existing.dob ? new Date(existing.dob) : null; data.dob = incoming.dob ? new Date(incoming.dob) : null; }
        else if (f === "sex") { asNow.sex = existing.sex as never; data.sex = incoming.sex as never; }
        else if (f === "fullName") { asNow.fullName = existing.fullName; data.fullName = incoming.fullName; }
        else { asNow.phone = existing.phone; data.phone = incoming.phone; }
      }
      const p = await tx.patient.updateMany({ where: asNow, data });
      if (p.count !== 1) throw new ConflictError("The patient's details changed since this review was queued; keep them, or import again.");
    }
    await emitFacilityEvent(tx, {
      type: "LegacyPatientReviewDecided", aggregateId: r.id, facilityId: admin.facilityId, actorUserId: admin.userId,
      payload: { reviewId: r.id, patientId: r.patientId, decision, fields: decision === "ACCEPTED" ? fields : [] },
    });
    return tx.legacyPatientReview.findUniqueOrThrow({ where: { id: r.id } });
  });
  await recordAuditEvent(decision === "ACCEPTED" ? "hospital.legacy-import.review.accepted" : "hospital.legacy-import.review.kept", admin.userId, { reviewId: r.id, patientId: r.patientId, fields, reason }, { facilityId: admin.facilityId });
  return done;
}
