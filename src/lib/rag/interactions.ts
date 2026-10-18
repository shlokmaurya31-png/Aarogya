import { prisma } from "@/lib/db";

/**
 * Week 4b — AI interactions (docs/RAG_DESIGN.md §3.3, §4.3). This file holds
 * the record's retention side; logging and reviewer reads are added with
 * POST /api/ai/ask.
 */

/** A family member's access was revoked: the text kept of their AI questions about the patient goes (metadata stays). */
export async function purgeProxyAiText(proxyGrantId: string): Promise<number> {
  return (await prisma.aiInteraction.updateMany({
    where: { proxyGrantId, questionCiphertext: { not: null } },
    data: { questionCiphertext: null, answerCiphertext: null, keyVersion: null, textScope: null, textExpiresAt: null },
  })).count;
}
