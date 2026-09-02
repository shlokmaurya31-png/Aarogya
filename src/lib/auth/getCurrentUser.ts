import { prisma } from "@/lib/db";
import { getSession } from "./session";

/** Server Component-friendly current-user loader. Returns null if unauthenticated. */
export async function getCurrentUser() {
  const session = await getSession();
  if (!session) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: { studentProfile: { include: { institution: true } } },
  });
  return user;
}
