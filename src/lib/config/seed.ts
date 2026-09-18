import { prisma } from "@/lib/db";
import { loadActorMemberships } from "@/lib/auth/tenantContext";
import { setOverride, publishOverride } from "./overrides";

/**
 * Phase D8 — a tiny demo configuration seed proving the value proposition: the same
 * code base behaving differently per hospital via a published override. Idempotent.
 */
export async function ensureConfigSeed(platformUserId: string, organizationId: string): Promise<{ created: number }> {
  const key = "workflow.critical-lab-review.sla";
  const existing = await prisma.configurationOverride.findFirst({ where: { organizationId, key, status: "PUBLISHED" }, select: { id: true } });
  if (existing) return { created: 0 };
  const m = await loadActorMemberships(platformUserId, "AAROGYA_ADMIN");
  // This org reviews critical labs faster than the workflow's own default (15m).
  await setOverride(m, { scope: "ORGANIZATION", organizationId, key, value: "10m", reason: "Demo: org-level SLA override" });
  await publishOverride(m, { scope: "ORGANIZATION", organizationId, key, reason: "Demo publish" });
  return { created: 1 };
}
