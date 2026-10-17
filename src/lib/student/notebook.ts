import { prisma } from "@/lib/db";
import { BadRequestError } from "@/lib/auth/rbac";

/** A student's private notebook (batch 7, item 5; previously written by the route). SCHOLAR: no domain events. */
export async function createNotebookEntry(input: { userId: string; title?: string; body?: string; specialty?: string; caseId?: string; tags?: unknown }) {
  if (!input.title?.trim() || !input.body?.trim()) throw new BadRequestError("title and body are required.");
  const tags = input.tags ?? [];
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) throw new BadRequestError("tags must be a list of strings.");
  return prisma.notebookEntry.create({ data: { userId: input.userId, title: input.title, body: input.body, specialty: input.specialty || undefined, caseId: input.caseId || undefined, tags } });
}

/** Deletes the student's own entry (another user's id matches nothing). */
export async function deleteNotebookEntry(input: { userId: string; id: string }) {
  await prisma.notebookEntry.deleteMany({ where: { id: input.id, userId: input.userId } });
}
