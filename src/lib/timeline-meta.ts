import { Droplet, Scan, Brain, Syringe, Stethoscope, BedDouble } from "lucide-react";
import type { TimelineEventType } from "@/types";

export const TIMELINE_TYPE_META: Record<
  TimelineEventType,
  { icon: typeof Droplet; color: string; label: string }
> = {
  "blood-test": { icon: Droplet, color: "#dc2626", label: "Blood Test" },
  "ct-scan": { icon: Scan, color: "#0e7490", label: "CT Scan" },
  mri: { icon: Brain, color: "#0e7490", label: "MRI" },
  vaccination: { icon: Syringe, color: "#15803d", label: "Vaccination" },
  "doctor-visit": { icon: Stethoscope, color: "#b45309", label: "Doctor Visit" },
  hospitalization: { icon: BedDouble, color: "#dc2626", label: "Hospitalization" },
};

export function formatEventDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
