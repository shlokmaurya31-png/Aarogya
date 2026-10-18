import { prisma } from "@/lib/db";
import { issuePermit } from "./documents/permit";
import type { ProcessingPermit } from "./documents/types";
import { issueAiPermit } from "./record/permit";
import type { AiPermit } from "./record/types";

/**
 * Week 4a — the real-data switch (docs/DOCUMENT_PIPELINE_DESIGN.md §11,
 * docs/RAG_DESIGN.md §11; docs/PRE_LAUNCH_CHECKLIST.md).
 *
 * A Person's data reaches the document pipeline or an AI provider only when:
 *   - the Person is SYNTHETIC (demo and gate data), or
 *   - the Person is REAL, the global switch is on (AI_REAL_DATA_ENABLED=true,
 *     off by default and to stay off until the checklist's blocking items are
 *     done), AND the person granted the purpose's consent.
 * Anything else is refused with a closed reason, never silently processed.
 */
export const REAL_DATA_PURPOSES = ["DOCUMENT_PROCESSING", "AI_ASSISTANCE"] as const;
export type RealDataPurpose = (typeof REAL_DATA_PURPOSES)[number];
export type RealDataRefusal = "REAL_DATA_DISABLED" | "CONSENT_REQUIRED" | "PERSON_NOT_ACTIVE";

export function realDataEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.AI_REAL_DATA_ENABLED === "true";
}

export async function mayProcessPersonData(personId: string, purpose: RealDataPurpose, env = process.env): Promise<{ allowed: true } | { allowed: false; reason: RealDataRefusal }> {
  const person = await prisma.person.findUnique({ where: { id: personId }, select: { status: true, dataClassification: true } });
  if (!person || person.status !== "ACTIVE") return { allowed: false, reason: "PERSON_NOT_ACTIVE" };
  if (person.dataClassification === "SYNTHETIC") return { allowed: true };
  if (!realDataEnabled(env)) return { allowed: false, reason: "REAL_DATA_DISABLED" };
  const consent = await prisma.personConsent.findFirst({ where: { personId, purpose, status: "ACTIVE" }, select: { decision: true } });
  return consent?.decision === "GRANTED" ? { allowed: true } : { allowed: false, reason: "CONSENT_REQUIRED" };
}

/**
 * The document pipeline's gate: a ProcessingPermit (the only way to call a
 * document provider) when mayProcessPersonData allows DOCUMENT_PROCESSING.
 */
export async function documentProcessingPermit(personId: string, env = process.env): Promise<{ allowed: true; permit: ProcessingPermit } | { allowed: false; reason: RealDataRefusal }> {
  const r = await mayProcessPersonData(personId, "DOCUMENT_PROCESSING", env);
  return r.allowed ? { allowed: true, permit: issuePermit(personId) } : r;
}

// ── Week 4b: the AI over the record (docs/RAG_DESIGN.md §11) ─────────────────

export type AiRefusal = RealDataRefusal | "AI_DECLINED" | "NOT_FOUND";

/** Whose data, for the AI: a facility record (its facility's classification) or a Person's own. */
export type AiDataOwner = { facilityId: string; patientId: string } | { personId: string };

/** The person's current AI_ASSISTANCE decision. */
async function aiDecision(personId: string): Promise<"GRANTED" | "DECLINED" | null> {
  const row = await prisma.personConsent.findFirst({ where: { personId, purpose: "AI_ASSISTANCE", status: "ACTIVE" }, select: { decision: true } });
  return row?.decision ?? null;
}

/**
 * May the AI index, embed or answer over this owner's data? An explicit
 * decline always refuses, synthetic data included. SYNTHETIC data needs
 * nothing more. REAL data needs the switch on AND the Person's AI_ASSISTANCE
 * consent (a facility record's Person is its ACTIVE link's; a record with no
 * Person can't consent, so it is refused).
 */
export async function mayUseAiOver(owner: AiDataOwner, env = process.env): Promise<{ allowed: true; real: boolean; personId: string | null } | { allowed: false; reason: AiRefusal }> {
  if ("personId" in owner) {
    const person = await prisma.person.findUnique({ where: { id: owner.personId }, select: { status: true, dataClassification: true } });
    if (!person) return { allowed: false, reason: "NOT_FOUND" };
    if (person.status !== "ACTIVE") return { allowed: false, reason: "PERSON_NOT_ACTIVE" };
    const decision = await aiDecision(owner.personId);
    if (decision === "DECLINED") return { allowed: false, reason: "AI_DECLINED" };
    if (person.dataClassification === "SYNTHETIC") return { allowed: true, real: false, personId: owner.personId };
    if (!realDataEnabled(env)) return { allowed: false, reason: "REAL_DATA_DISABLED" };
    return decision === "GRANTED" ? { allowed: true, real: true, personId: owner.personId } : { allowed: false, reason: "CONSENT_REQUIRED" };
  }
  const facility = await prisma.facility.findUnique({ where: { id: owner.facilityId }, select: { dataClassification: true } });
  if (!facility) return { allowed: false, reason: "NOT_FOUND" };
  const link = await prisma.personPatientLink.findFirst({ where: { patientId: owner.patientId, facilityId: owner.facilityId, status: "ACTIVE" }, select: { personId: true, person: { select: { status: true } } } });
  const decision = link ? await aiDecision(link.personId) : null;
  if (decision === "DECLINED") return { allowed: false, reason: "AI_DECLINED" };
  if (facility.dataClassification === "SYNTHETIC") return { allowed: true, real: false, personId: link?.personId ?? null };
  if (!realDataEnabled(env)) return { allowed: false, reason: "REAL_DATA_DISABLED" };
  if (!link || link.person.status !== "ACTIVE") return { allowed: false, reason: "CONSENT_REQUIRED" };
  return decision === "GRANTED" ? { allowed: true, real: true, personId: link.personId } : { allowed: false, reason: "CONSENT_REQUIRED" };
}

/** The AI's gate: a permit (the only way to call an embedding or answer provider), or a closed refusal. */
export async function aiAssistancePermit(owner: AiDataOwner, env = process.env): Promise<{ allowed: true; permit: AiPermit; real: boolean; personId: string | null } | { allowed: false; reason: AiRefusal }> {
  const r = await mayUseAiOver(owner, env);
  if (!r.allowed) return r;
  const subject = "personId" in owner ? `person:${owner.personId}` : `patient:${owner.patientId}`;
  return { ...r, permit: issueAiPermit(subject, r.real) };
}
