import { prisma } from "@/lib/db";

/**
 * Replaces a user's password hash (batch 7, item 5; the password change and
 * reset routes wrote it directly). ACCOUNT_SECURITY: audited by the caller
 * (security.password.*); never an event, which must not carry credentials.
 */
export async function replacePasswordHash(userId: string, passwordHash: string) {
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
}
