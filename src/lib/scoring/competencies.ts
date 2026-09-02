import { prisma } from "@/lib/db";
import type { CaseScoreBreakdown } from "./engine";

const DIMENSION_TO_DOMAIN: Record<string, string> = {
  history: "History Taking",
  examination: "Physical Examination",
  differential: "Clinical Reasoning",
  diagnosis: "Clinical Reasoning",
  management: "Clinical Reasoning",
  investigations: "Diagnostics",
  prescription: "Pharmacology",
  safety: "Patient Safety",
  documentation: "Documentation",
};

/** Rolls a completed attempt's score into the student's per-domain competency averages. */
export async function updateCompetencies(userId: string, breakdown: CaseScoreBreakdown) {
  const byDomain = new Map<string, { earned: number; max: number }>();
  for (const dim of breakdown.dimensions) {
    const domain = DIMENSION_TO_DOMAIN[dim.key] ?? dim.label;
    const acc = byDomain.get(domain) ?? { earned: 0, max: 0 };
    acc.earned += dim.earned;
    acc.max += dim.maxEarnable;
    byDomain.set(domain, acc);
  }

  for (const [domain, { earned, max }] of byDomain) {
    const percent = max > 0 ? (earned / max) * 100 : 0;
    const existing = await prisma.studentCompetency.findUnique({ where: { userId_domain: { userId, domain } } });
    const nextAttempts = (existing?.attempts ?? 0) + 1;
    const nextScore = existing ? (existing.score * existing.attempts + percent) / nextAttempts : percent;
    await prisma.studentCompetency.upsert({
      where: { userId_domain: { userId, domain } },
      update: { score: nextScore, attempts: nextAttempts },
      create: { userId, domain, score: percent, attempts: 1 },
    });
  }
}
