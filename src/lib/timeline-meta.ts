import { Droplet, Scan, Brain, Syringe, Stethoscope, BedDouble } from "lucide-react";
import type { TimelineEventType } from "@/types";

export const TIMELINE_TYPE_META: Record<
  TimelineEventType,
  { icon: typeof Droplet; color: string; label: string }
> = {
  "blood-test": { icon: Droplet, color: "#ff6b6b", label: "Blood Test" },
  "ct-scan": { icon: Scan, color: "#78c8ff", label: "CT Scan" },
  mri: { icon: Brain, color: "#78c8ff", label: "MRI" },
  vaccination: { icon: Syringe, color: "#8fe388", label: "Vaccination" },
  "doctor-visit": { icon: Stethoscope, color: "#f8c84b", label: "Doctor Visit" },
  hospitalization: { icon: BedDouble, color: "#ff6b6b", label: "Hospitalization" },
};

export function formatEventDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
