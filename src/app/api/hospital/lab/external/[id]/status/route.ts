import { NextRequest } from "next/server";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";
import { transitionExternalReferral } from "@/lib/hospital/diagnosticsAdvanced";
import type { ExternalLabStatus } from "@prisma/client";

const VALID: ExternalLabStatus[] = ["DRAFT", "SENT", "RESULT_RECEIVED", "REVIEWED", "CANCELLED"];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("lab:external:manage", body?.facilityId);
    if (!staff) throw new BadRequestError("External referral update requires a lab staff account.");
    if (!body?.to || !VALID.includes(body.to)) throw new BadRequestError("A valid target status is required.");
    const referral = await transitionExternalReferral({ referralId: id, facilityId, to: body.to, actorStaffId: staff.id, externalAccession: body.externalAccession, resultDocumentRef: body.resultDocumentRef, notes: body.notes, byUserId: session.userId });
    return { referral };
  });
}
