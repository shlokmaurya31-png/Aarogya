import { prisma } from "@/lib/db";
import { emitDomainEvent } from "@/lib/events/emit";

/**
 * Week 4b — consents lapse at 18 (docs/RAG_DESIGN.md §11.3, decision 10;
 * pipeline §9). A choice decided before the person turned 18 was, in effect,
 * a guardian's: on the 18th birthday it lapses to "needs your confirmation"
 * (LAPSED), whatever the purpose and whichever way it went, and counts as not
 * granted until the person chooses again. Run by the runner's sweep; one
 * PersonConsentLapsed per consent, in the same transaction.
 *
 * The AI index of a lapsed AI_ASSISTANCE consent is kept for
 * ai.lapsed_consent_index_days (90) so confirming needs no rebuild, then
 * removed (src/lib/rag/indexer.ts purgeLapsedAiIndexes).
 */
const ADULT_YEARS = 18;

export function eighteenthBirthday(dob: Date): Date {
  const d = new Date(dob);
  d.setUTCFullYear(d.getUTCFullYear() + ADULT_YEARS);
  return d;
}

export async function sweepConsentLapses(opts: { now?: Date; batchSize?: number } = {}): Promise<{ lapsed: number }> {
  const now = opts.now ?? new Date();
  // People who are 18 by now; their ACTIVE choices decided before that birthday.
  const adultBefore = new Date(now);
  adultBefore.setUTCFullYear(adultBefore.getUTCFullYear() - ADULT_YEARS);
  const candidates = await prisma.personConsent.findMany({
    where: { status: "ACTIVE", person: { dateOfBirth: { not: null, lte: adultBefore } } },
    select: { id: true, personId: true, purpose: true, decidedAt: true, person: { select: { dateOfBirth: true } } },
    take: opts.batchSize ?? 500,
  });
  let lapsed = 0;
  for (const c of candidates) {
    if (c.decidedAt >= eighteenthBirthday(c.person.dateOfBirth!)) continue;
    await prisma.$transaction(async (tx) => {
      const r = await tx.personConsent.updateMany({ where: { id: c.id, status: "ACTIVE" }, data: { status: "LAPSED", lapsedAt: now } });
      if (r.count !== 1) return;
      await emitDomainEvent(tx, { type: "PersonConsentLapsed", aggregateId: c.personId, personId: c.personId, payload: { personId: c.personId, consentId: c.id, purpose: c.purpose, reason: "TURNED_18" } });
      lapsed += 1;
    });
  }
  return { lapsed };
}
