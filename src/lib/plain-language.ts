import type { RiskLevel, SystemId } from "@/types";

export const RISK_FRIENDLY: Record<RiskLevel, { label: string; color: string }> = {
  optimal: { label: "All good", color: "#8fe388" },
  watch: { label: "Worth watching", color: "#78c8ff" },
  elevated: { label: "Needs attention", color: "#f8c84b" },
  critical: { label: "Talk to your doctor soon", color: "#ff6b6b" },
};

export const SYSTEM_FRIENDLY: Record<SystemId, string> = {
  brain: "Your sleep and stress levels look steady. Nothing to worry about here.",
  heart: "Your heart is working well. Blood pressure is a touch high — worth mentioning at your next visit.",
  lungs: "Breathing and oxygen levels are right where they should be.",
  kidneys: "Your blood sugar has been creeping up. Small changes to food and activity can help.",
  bones: "Bone strength is slightly low. A bit more sunlight and vitamin D should help.",
};

export const REPORT_FRIENDLY: Record<string, string> = {
  r1: "Your blood sugar and cholesterol were a little high. Your doctor may suggest small diet changes.",
  r2: "A scan of your lower back showed slightly weaker bone in one spot — more vitamin D should help.",
  r3: "Summary from your hospital stay in September. Everything was handled and closed out.",
  r4: "A brain scan taken as a routine check. Nothing unusual was found.",
  r5: "The medicines your doctor prescribed after your last visit.",
};

export function overallStatus(risks: RiskLevel[]): { label: string; message: string; color: string } {
  if (risks.includes("critical")) {
    return { label: "Needs attention", message: "A couple of things need your attention today.", color: "#ff6b6b" };
  }
  if (risks.includes("elevated")) {
    return { label: "Mostly good", message: "You're doing okay — one or two things worth watching.", color: "#f8c84b" };
  }
  if (risks.includes("watch")) {
    return { label: "Doing well", message: "You're doing well overall, just keep an eye on a couple of things.", color: "#78c8ff" };
  }
  return { label: "Doing great", message: "Everything looks good today.", color: "#8fe388" };
}
