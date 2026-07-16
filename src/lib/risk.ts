import type { RiskLevel } from "@/types";

export const RISK_COLOR: Record<RiskLevel, string> = {
  optimal: "#8fe388",
  watch: "#78c8ff",
  elevated: "#f8c84b",
  critical: "#ff6b6b",
};

export const RISK_LABEL: Record<RiskLevel, string> = {
  optimal: "Optimal",
  watch: "Monitor",
  elevated: "Elevated",
  critical: "Critical",
};
