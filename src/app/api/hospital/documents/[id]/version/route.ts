import { NextRequest } from "next/server";
import { versionStaffDocument } from "@/lib/documents/staffDocuments";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
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

    const { title, storageRef, accessPolicy } = body ?? {};
    const created = await versionStaffDocument({ documentId: id, facilityId, title, storageRef, accessPolicy, staffId: staff.id, byUserId: session.userId });

    await recordAuditEvent(
      "hospital.document.versioned",
      session.userId,
      { documentId: created.id, supersedesId: created.supersedesId, version: created.version },
      { facilityId, patientId: created.patientId, encounterId: created.encounterId ?? undefined }
    );
    return { document: created };
  });
}
