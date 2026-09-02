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
      const amendmentReason = body?.amendmentReason as string | undefined;
      if (!amendmentReason) throw new BadRequestError("amendmentReason is required when amending a signed note.");
      await prisma.clinicalNote.update({
        where: { id: body.supersedesId },
        data: { status: "SUPERSEDED", amendedAt: new Date(), amendmentReason },
      });
    }

    const note = await prisma.clinicalNote.create({
      data: {
        encounterId: id,
        authorStaffId: staff.id,
        authorRole: session.role,
        type,
        content,
        status: sign ? "SIGNED" : "DRAFT",
        signedAt: sign ? new Date() : undefined,
        supersedesId: body?.supersedesId,
      },
    });

    await recordAuditEvent("hospital.note.created", session.userId, { encounterId: id, noteId: note.id, type });
    if (body?.supersedesId) await recordAuditEvent("hospital.note.amended", session.userId, { encounterId: id, noteId: note.id, supersedesId: body.supersedesId });
    return { note };
  });
}

/**
 * Signs an existing DRAFT note in place (brief §18/§57 item 13). Locking a
 * draft is not "overwriting" content — only DRAFT -> SIGNED is allowed here;
 * a SIGNED or SUPERSEDED note is immutable and must be amended via a new
 * POST with `supersedesId` instead (see docs/CLINICAL_CORE.md §5).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withApiErrors(async () => {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const { session, facilityId, staff } = await requireFacilityStaff("clinical:note:create", body?.facilityId);
    if (!staff) throw new BadRequestError("Notes must be signed by a staff account.");

    const encounter = await prisma.encounter.findUnique({ where: { id } });
    if (!encounter || encounter.facilityId !== facilityId) throw new NotFoundError("Encounter not found.");

    const noteId = body?.noteId as string | undefined;
    if (!noteId || body?.action !== "sign") throw new BadRequestError("noteId and action=\"sign\" are required.");

    const existing = await prisma.clinicalNote.findUnique({ where: { id: noteId } });
    if (!existing || existing.encounterId !== id) throw new NotFoundError("Note not found.");
    if (existing.status !== "DRAFT") throw new BadRequestError(`Only a DRAFT note can be signed (current status: ${existing.status}).`);

    const note = await prisma.clinicalNote.update({
      where: { id: noteId },
      data: { status: "SIGNED", signedAt: new Date() },
    });

    await recordAuditEvent("hospital.note.signed", session.userId, { encounterId: id, noteId: note.id });
    return { note };
  });
}
