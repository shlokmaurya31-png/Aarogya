/**
 * Flagship 4d — the ward tablet's early warning: NEWS2 (Royal College of
 * Physicians, 2017) as the PLACEHOLDER for "Call the doctor now", pending the
 * clinical advisor's sign-off (docs/OFFLINE_NURSING_DESIGN.md §6.4, §13.6).
 * It replaces the wide thresholds of Flagship 4c on the tablet only; no other
 * clinical rule changes. SpO2 uses Scale 1 (Scale 2, for hypercapnic
 * respiratory failure, needs a clinician to choose it per patient: not
 * offered). A parameter not recorded scores nothing, and the result says how
 * many were scored.
 */
export const NEWS2_STATUS = "pending clinical sign-off";

export type Consciousness = "ALERT" | "NEW_CONFUSION" | "VOICE" | "PAIN" | "UNRESPONSIVE";
export interface News2Input { rr?: number; spo2?: number; onOxygen?: boolean; sbp?: number; hr?: number; consciousness?: Consciousness; tempC?: number }
export type News2Response = "ROUTINE" | "WARD" | "URGENT" | "EMERGENCY";
export interface News2Result {
  score: number;
  /** Per parameter: its points (only the ones recorded). */
  parts: Partial<Record<keyof News2Input, number>>;
  /** True when one parameter alone scores 3 (a "red" score). */
  red: boolean;
  scored: number;
  response: News2Response;
  /** "Call the doctor now": an aggregate of 5 or more, or any single red score. */
  callDoctor: boolean;
}

const band = (v: number, rows: [number, number][]) => {
  // rows: [upper bound inclusive, points], ascending; the last row takes everything above.
  for (const [hi, pts] of rows) if (v <= hi) return pts;
  return rows[rows.length - 1][1];
};

export function news2(v: News2Input): News2Result {
  const parts: News2Result["parts"] = {};
  if (v.rr !== undefined) parts.rr = band(v.rr, [[8, 3], [11, 1], [20, 0], [24, 2], [Infinity, 3]]);
  if (v.spo2 !== undefined) parts.spo2 = band(v.spo2, [[91, 3], [93, 2], [95, 1], [Infinity, 0]]);
  if (v.onOxygen !== undefined) parts.onOxygen = v.onOxygen ? 2 : 0;
  if (v.sbp !== undefined) parts.sbp = band(v.sbp, [[90, 3], [100, 2], [110, 1], [219, 0], [Infinity, 3]]);
  if (v.hr !== undefined) parts.hr = band(v.hr, [[40, 3], [50, 1], [90, 0], [110, 1], [130, 2], [Infinity, 3]]);
  if (v.consciousness !== undefined) parts.consciousness = v.consciousness === "ALERT" ? 0 : 3;
  if (v.tempC !== undefined) parts.tempC = band(v.tempC, [[35.0, 3], [36.0, 1], [38.0, 0], [39.0, 1], [Infinity, 2]]);
  const values = Object.values(parts) as number[];
  const score = values.reduce((a, b) => a + b, 0);
  const red = values.some((p) => p === 3);
  const response: News2Response = score >= 7 ? "EMERGENCY" : score >= 5 ? "URGENT" : red ? "URGENT" : score >= 1 ? "WARD" : "ROUTINE";
  return { score, parts, red, scored: values.length, response, callDoctor: score >= 5 || red };
}
