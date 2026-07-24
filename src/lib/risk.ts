import type { RiskLevel } from "@/types";

export const RISK_COLOR: Record<RiskLevel, string> = {
  optimal: "#15803d",
  watch: "#0e7490",
  elevated: "#b45309",
  critical: "#dc2626",
};

export const RISK_LABEL: Record<RiskLevel, string> = {
  optimal: "Optimal",
  watch: "Monitor",
  elevated: "Elevated",
  critical: "Critical",
};
