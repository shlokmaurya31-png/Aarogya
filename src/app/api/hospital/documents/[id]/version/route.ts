import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/**
 * Creates a new version of a clinical document (brief §17) — non-destructive.
 * The prior CURRENT row is guarded-transitioned to SUPERSEDED (never
 * overwritten or deleted) and a new CURRENT row is created with an
 * incremented version, in one transaction. Two concurrent version bumps of
 * the same document can't both win (the guarded updateMany on status=CURRENT
 * lets exactly one proceed).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("document:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("Documents must be recorded by a staff account.");

    const prior = await prisma.clinicalDocument.findUnique({ where: { id } });
    if (!prior || prior.facilityId !== facilityId) throw new NotFoundError("Document not found.");
    if (prior.status !== "CURRENT") throw new BadRequestError("Only the current version of a document can be superseded.");

    const { title, storageRef, accessPolicy } = body ?? {};

    const created = await prisma.$transaction(async (tx) => {
      const cas = await tx.clinicalDocument.updateMany({
        where: { id, status: "CURRENT" },
        data: { status: "SUPERSEDED" },
      });
      if (cas.count !== 1) throw new BadRequestError("Document was updated by someone else — refresh and try again.");

      return tx.clinicalDocument.create({
        data: {
          facilityId,
          patientId: prior.patientId,
          encounterId: prior.encounterId,
          type: prior.type,
          title: title ?? prior.title,
          storageRef: storageRef ?? prior.storageRef,
          version: prior.version + 1,
          supersedesId: prior.id,
          status: "CURRENT",
          accessPolicy: accessPolicy ?? prior.accessPolicy,
          authorStaffId: staff.id,
          uploadedByStaffId: staff.id,
        },
      });
    });

    await recordAuditEvent(
      "hospital.document.versioned",
      session.userId,
      { documentId: created.id, supersedesId: prior.id, version: created.version },
      { facilityId, patientId: prior.patientId, encounterId: prior.encounterId ?? undefined }
    );
    return { document: created };
  });
}
