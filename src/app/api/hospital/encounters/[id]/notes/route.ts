import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireFacilityStaff } from "@/lib/auth/hospitalRbac";
import { withApiErrors, BadRequestError, NotFoundError } from "@/lib/auth/rbac";
import { recordAuditEvent } from "@/lib/auth/audit";

/**
 * Clinical documentation (brief §18/§185): signed notes are never mutated —
 * an "amendment" is a new note with `supersedesId` pointing at the old one,
 * and the old note's status flips to SUPERSEDED. This keeps the timeline
 * immutable/auditable per brief §16.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("clinical:note:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Notes must be authored by a staff account.");

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const type = body?.type as string | undefined;
    const content = body?.content;
    if (!type || !content) throw new BadRequestError("type and content are required.");

    const sign = Boolean(body?.sign);

    if (body?.supersedesId) {
      await prisma.clinicalNote.update({ where: { id: body.supersedesId }, data: { status: "SUPERSEDED" } });
    }

    const note = await prisma.clinicalNote.create({
      data: {
        encounterId: id,
        authorStaffId: staff.id,
        type,
        content,
        status: sign ? "SIGNED" : "DRAFT",
        signedAt: sign ? new Date() : undefined,
        supersedesId: body?.supersedesId,
      },
    });

    await recordAuditEvent("hospital.note.created", session.userId, { encounterId: id, noteId: note.id, type });
    return { note };
  });
}
