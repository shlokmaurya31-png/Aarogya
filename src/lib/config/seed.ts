import { prisma } from "@/lib/db";
import { loadActorMemberships } from "@/lib/auth/tenantContext";
import { setOverride, publishOverride } from "./overrides";

/**
 * Phase D8 — a tiny demo configuration seed proving the value proposition: the same
 * code base behaving differently per hospital via a published override. Idempotent.
 */
export async function ensureConfigSeed(platformUserId: string, organizationId: string): Promise<{ created: number }> {
  const m = await loadActorMemberships(platformUserId, "AAROGYA_ADMIN");
  let created = 0;
  const key = "workflow.critical-lab-review.sla";
  if (!(await prisma.configurationOverride.findFirst({ where: { organizationId, key, status: "PUBLISHED" }, select: { id: true } }))) {
    // This org reviews critical labs faster than the workflow's own default (15m).
    await setOverride(m, { scope: "ORGANIZATION", organizationId, key, value: "10m", reason: "Demo: org-level SLA override" });
    await publishOverride(m, { scope: "ORGANIZATION", organizationId, key, reason: "Demo publish" });
    created += 1;
  }
  // Week 4b: the AI assistant is on at the seeded SYNTHETIC demo facilities only; every
  // other facility keeps the default (off), and real data still needs the real-data switch.
  for (const f of await prisma.facility.findMany({ where: { organizationId, dataClassification: "SYNTHETIC" }, select: { id: true } })) {
    if (await prisma.configurationOverride.findFirst({ where: { facilityId: f.id, key: "ai.enabled", status: "PUBLISHED" }, select: { id: true } })) continue;
    await setOverride(m, { scope: "FACILITY", organizationId, facilityId: f.id, key: "ai.enabled", value: "true", reason: "Demo: AI assistant on at a synthetic facility" });
    await publishOverride(m, { scope: "FACILITY", organizationId, facilityId: f.id, key: "ai.enabled", reason: "Demo publish" });
    created += 1;
  }
  return { created };
}
