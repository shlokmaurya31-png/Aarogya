import { prisma } from "@/lib/db";
import { requireOwnedPerson, personDecision, SHARE_UPLOADS } from "./access";

/**
 * Phase 0 — what a person sees about their own identity: their Person, the
 * facility records linked to it, their sharing choice (and whether they still
 * need to make it), and their access log. Owner only (personAccess).
 */
export async function personOverview(userId: string) {
  const personId = await requireOwnedPerson(userId);
  const [person, links, decision, log] = await Promise.all([
    prisma.person.findUniqueOrThrow({ where: { id: personId }, select: { id: true, displayName: true, preferredLanguage: true, createdAt: true } }),
    prisma.personPatientLink.findMany({
      where: { personId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, status: true, method: true, linkedAt: true, unlinkedAt: true, facility: { select: { id: true, name: true } } },
    }),
    personDecision(personId, SHARE_UPLOADS),
    prisma.personAccessLogEntry.findMany({ where: { personId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 50, select: { id: true, kind: true, accessingFacilityId: true, createdAt: true } }),
  ]);
  return {
    person: { ...person, createdAt: person.createdAt.toISOString() },
    links: links.map((l) => ({ id: l.id, status: l.status, method: l.method, facility: l.facility, linkedAt: l.linkedAt?.toISOString() ?? null, unlinkedAt: l.unlinkedAt?.toISOString() ?? null })),
    // Week 4a: every person-level choice (no defaults: null = not chosen).
    consents: Object.fromEntries(await Promise.all((["SHARE_UPLOADS_WITH_TREATING", "DOCUMENT_PROCESSING", "AI_ASSISTANCE", "AI_TEXT_RETENTION"] as const).map(async (p) => [p, await personDecision(personId, p)]))),
    sharing: {
      uploadsWithTreatingHospitals: decision,
      // No pre-selected answer: until the person chooses, they are asked (at
      // sign-up, and at next login for accounts from before Phase 0).
      choiceNeeded: decision === null,
    },
    accessLog: log.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
  };
}
