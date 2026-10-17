import { createNotebookEntry, deleteNotebookEntry } from "@/lib/student/notebook";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireVerifiedStudent } from "@/lib/auth/currentStudent";
import { withApiErrors, BadRequestError } from "@/lib/auth/rbac";

export async function GET() {
  return withApiErrors(async () => {
    const { session } = await requireVerifiedStudent("student:notes:create");
    const entries = await prisma.notebookEntry.findMany({ where: { userId: session.userId }, orderBy: { createdAt: "desc" } });
    return { entries };
  });
}

export async function POST(req: NextRequest) {
  return withApiErrors(async () => {
    const { session } = await requireVerifiedStudent("student:notes:create");
    const body = await req.json().catch(() => null);
    const entry = await createNotebookEntry({ userId: session.userId, title: body?.title, body: body?.body, specialty: body?.specialty, caseId: body?.caseId, tags: body?.tags });
    return { entry };
  });
}

export async function DELETE(req: NextRequest) {
  return withApiErrors(async () => {
    const { session } = await requireVerifiedStudent("student:notes:create");
    const id = new URL(req.url).searchParams.get("id");
    if (!id) throw new BadRequestError("id is required.");
    await deleteNotebookEntry({ userId: session.userId, id });
    return { ok: true };
  });
}
