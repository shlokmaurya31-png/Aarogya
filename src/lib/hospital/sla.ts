import { prisma } from "@/lib/db";

/**
 * Configurable operational SLA thresholds (brief §52) — hospital
 * operational configuration, explicitly NOT a hard-coded clinical
 * standard. `SlaPolicy` rows override these defaults per facility+metric;
 * a facility with no override row uses the default below.
 */
export const DEFAULT_SLA_MINUTES: Record<string, number> = {
  REGISTRATION_WAIT: 10,
  ED_DOCTOR_WAIT: 30,
  ADMISSION_ALLOCATION: 30,
  TRANSFER: 45,
  DISCHARGE_READY: 60,
};

export async function getSlaThresholds(facilityId: string): Promise<Record<string, number>> {
  const overrides = await prisma.slaPolicy.findMany({ where: { facilityId } });
  const merged = { ...DEFAULT_SLA_MINUTES };
  for (const o of overrides) merged[o.metric] = o.thresholdMinutes;
  return merged;
}
