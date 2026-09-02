import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireVerifiedStudent } from "@/lib/auth/currentStudent";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";

export async function GET() {
  return withApiErrors(async () => {
    const { session } = await requireVerifiedStudent("student:notes:create");
    const entries = await prisma.notebookEntry.findMany({ where: { userId: session.userId }, orderBy: { createdAt: "desc" } });
    return { entries: entries.map((e) => ({ ...e, tags: JSON.parse(e.tags || "[]") })) };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const { session } = await requireVerifiedStudent("student:notes:create");
    const body = await req.json().catch(() => null);
    const title = body?.title as string | undefined;
    const bodyText = body?.body as string | undefined;
    if (!title?.trim() || !bodyText?.trim()) throw new BadRequestError("title and body are required.");

    const entry = await prisma.notebookEntry.create({
      data: {
        userId: session.userId,
        title,
        body: bodyText,
        specialty: body?.specialty || undefined,
        caseId: body?.caseId || undefined,
        tags: JSON.stringify(body?.tags ?? []),
      },
    });
    return { entry: { ...entry, tags: JSON.parse(entry.tags) } };
  });
}

export async function DELETE(req: NextRequest) {
  return withApiErrors(async () => {
    const { session } = await requireVerifiedStudent("student:notes:create");
    const id = new URL(req.url).searchParams.get("id");
    if (!id) throw new BadRequestError("id is required.");
    await prisma.notebookEntry.deleteMany({ where: { id, userId: session.userId } });
    return { ok: true };
  });
}
