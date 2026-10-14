/**
 * Marketing copy for the public landing page: an illustrative, fictional
 * "health story" shown in the timeline section. It is NOT patient data and
 * must never feed a clinical, portal or API code path. ESLint enforces that:
 * only src/components/landing may import from src/content/marketing
 * (eslint.config.mjs, no-restricted-imports).
 */
import type { TimelineEventType } from "@/types";

export interface LandingStoryEvent {
  id: string;
  date: string;
  type: TimelineEventType;
  title: string;
  facility: string;
  description: string;
}

export const landingStoryTimeline: LandingStoryEvent[] = [
  {
    id: "t1",
    date: "2026-06-14",
    type: "doctor-visit",
    title: "Cardiology Consultation",
    facility: "Fortis Hospital, Pune",
    description: "Dr. Rakesh Sharma reviewed 8-year cardiac history. AI flagged possible ACE inhibitor / statin interaction. Dosage adjusted.",
  },
  {
    id: "t2",
    date: "2026-06-02",
    type: "blood-test",
    title: "HbA1c + Lipid Panel",
    facility: "SRL Diagnostics, Bhopal",
    description: "Results uploaded directly by lab via secure API. No paper report generated.",
  },
  {
    id: "t3",
    date: "2026-03-21",
    type: "vaccination",
    title: "Influenza Booster",
    facility: "Apollo Pharmacy, Pune",
    description: "Seasonal booster administered. Added to national vaccination registry.",
  },
  {
    id: "t4",
    date: "2026-01-12",
    type: "ct-scan",
    title: "Lumbar Spine CT",
    facility: "Max Healthcare, Delhi NCR",
    description: "Mild reduced density noted in L3–L4. Recommended vitamin D supplementation.",
  },
  {
    id: "t5",
    date: "2025-09-08",
    type: "hospitalization",
    title: "Cardiac Observation (2 Days)",
    facility: "Fortis Hospital, Pune",
    description: "Admitted for chest discomfort. Discharge summary auto-uploaded, insurance claim approved in 4 hours.",
  },
  {
    id: "t6",
    date: "2025-04-30",
    type: "mri",
    title: "Brain MRI (Routine Screening)",
    facility: "Manipal Hospitals, Bengaluru",
    description: "No structural abnormalities detected.",
  },
];
