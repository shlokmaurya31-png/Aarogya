import { prisma } from "@/lib/db";
import { issuePermit } from "./documents/permit";
import type { ProcessingPermit } from "./documents/types";

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
