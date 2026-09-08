import { prisma } from "@/lib/db";
import { BadRequestError, NotFoundError } from "@/lib/auth/rbac";

export class NoteConcurrencyError extends BadRequestError {
  constructor(status: string) {
    super(`This note is already ${status} — refresh and try again.`);
  }
}

/**
 * Signs a DRAFT note (brief §14/§24-F). Concurrency-safe via a guarded
 * updateMany (status: "DRAFT" in the WHERE, count-checked after) — the
 * previous plain-`update()` path checked status first but the write itself
 * had no guard, so two concurrent sign requests on the same DRAFT note
 * could both pass the check and both "succeed" before either committed.
 */
export async function signNote(input: { noteId: string; encounterId: string; byUserId: string }) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.clinicalNote.findUniqueOrThrow({ where: { id: input.noteId } });
    if (existing.encounterId !== input.encounterId) throw new NotFoundError("Note not found.");
    if (existing.status !== "DRAFT") throw new NoteConcurrencyError(existing.status);

    const result = await tx.clinicalNote.updateMany({
      where: { id: input.noteId, status: "DRAFT" },
      data: { status: "SIGNED", signedAt: new Date() },
    });
    if (result.count !== 1) throw new NoteConcurrencyError(existing.status);
    return tx.clinicalNote.findUniqueOrThrow({ where: { id: input.noteId } });
  });
}

/**
 * Amends a SIGNED note (brief §14/§24-F). A signed note is never mutated in
 * place: this guards the old note SIGNED -> SUPERSEDED with the same
 * updateMany CAS idiom, then creates the replacement, both inside one
 * transaction — closing two pre-existing bugs at once: (1) the two writes
 * (supersede + create) previously were NOT transactional, so a crash
 * between them could leave a SUPERSEDED note with no replacement; (2) the
 * supersede update had no status guard and no check that `supersedesId`
 * actually belongs to this encounter, so two concurrent amendments (or an
 * amendment referencing a note from a different encounter) could both
 * "succeed" / silently cross encounter boundaries.
 */
export async function amendNote(input: {
  supersedesId: string;
  encounterId: string;
  authorStaffId: string;
  authorRole: string;
  type: string;
  content: unknown;
  amendmentReason: string;
  byUserId: string;
}) {
  return prisma.$transaction(async (tx) => {
    const old = await tx.clinicalNote.findUniqueOrThrow({ where: { id: input.supersedesId } });
    if (old.encounterId !== input.encounterId) throw new NotFoundError("Note not found.");
    if (old.status !== "SIGNED") throw new NoteConcurrencyError(old.status);

    const result = await tx.clinicalNote.updateMany({
      where: { id: input.supersedesId, status: "SIGNED" },
      data: { status: "SUPERSEDED", amendedAt: new Date(), amendmentReason: input.amendmentReason },
    });
    if (result.count !== 1) throw new NoteConcurrencyError(old.status);

    const note = await tx.clinicalNote.create({
      data: {
        encounterId: input.encounterId,
        authorStaffId: input.authorStaffId,
        authorRole: input.authorRole,
        type: input.type,
        content: input.content as never,
        status: "SIGNED",
        signedAt: new Date(),
        supersedesId: input.supersedesId,
      },
    });
    return note;
  });
}
