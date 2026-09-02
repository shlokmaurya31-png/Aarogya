import { prisma } from "@/lib/db";

/** Detects abnormal vitals ONLY against thresholds a facility has explicitly configured (VitalThreshold) — never a hardcoded clinical claim (brief §13). No row for a metric means no alert for it. */
export interface AbnormalVital {
  metric: string;
  value: number;
  minValue: number | null;
  maxValue: number | null;
}

export async function findAbnormalVitals(facilityId: string, vital: { hr: number | null; sbp: number | null; dbp: number | null; rr: number | null; spo2: number | null; tempC: number | null }): Promise<AbnormalVital[]> {
  const thresholds = await prisma.vitalThreshold.findMany({ where: { facilityId } });
  if (thresholds.length === 0) return [];

  const byMetric = new Map(thresholds.map((t) => [t.metric, t]));
  const abnormal: AbnormalVital[] = [];
  const metrics: [string, number | null][] = [
    ["hr", vital.hr], ["sbp", vital.sbp], ["dbp", vital.dbp], ["rr", vital.rr], ["spo2", vital.spo2], ["tempC", vital.tempC],
  ];
  for (const [metric, value] of metrics) {
    if (value == null) continue;
    const t = byMetric.get(metric);
    if (!t) continue;
    if ((t.minValue != null && value < t.minValue) || (t.maxValue != null && value > t.maxValue)) {
      abnormal.push({ metric, value, minValue: t.minValue, maxValue: t.maxValue });
    }
  }
  return abnormal;
}
