import type { NavId, PatientNavId, UserMode } from "@/types";

export interface PageAiContext {
  label: string;
  suggestions: string[];
}

const DOCTOR_CONTEXT: Record<NavId, PageAiContext> = {
  overview: {
    label: "Clinical Overview",
    suggestions: ["Summarize full history", "Check drug interactions", "Show lab trend", "Draft consultation note"],
  },
  appointments: {
    label: "Appointments",
    suggestions: [
      "Summarize today's schedule",
      "Prep notes for the next patient",
      "Flag scheduling conflicts",
      "Draft a reschedule message",
    ],
  },
  history: {
    label: "Medical History",
    suggestions: ["Summarize full history", "Highlight risk trends", "Compare to last visit", "Flag missed follow-ups"],
  },
  reports: {
    label: "Reports",
    suggestions: [
      "Summarize the latest report",
      "Compare to the previous report",
      "Flag abnormal findings",
      "Draft a referral note",
    ],
  },
  labs: {
    label: "Lab Results",
    suggestions: [
      "Explain out-of-range values",
      "Compare to reference trends",
      "Flag critical results",
      "Suggest follow-up tests",
    ],
  },
  prescriptions: {
    label: "Prescriptions",
    suggestions: ["Check drug interactions", "Review adherence", "Suggest a dosage adjustment", "Draft a refill note"],
  },
  insurance: {
    label: "Insurance",
    suggestions: ["Summarize claim status", "Draft a claim justification", "Check policy coverage", "Flag pending claims"],
  },
  emergency: {
    label: "Emergency",
    suggestions: [
      "Pull critical allergies",
      "Show emergency protocol",
      "Summarize vitals right now",
      "Contact emergency contact",
    ],
  },
};

const PATIENT_CONTEXT: Record<PatientNavId, PageAiContext> = {
  home: {
    label: "Home",
    suggestions: ["What should I eat today?", "Remind me about my pills", "Am I doing okay?", "Talk to my doctor"],
  },
  appointments: {
    label: "Appointments",
    suggestions: [
      "What should I ask my doctor?",
      "Reschedule my appointment",
      "What should I bring?",
      "Remind me before my visit",
    ],
  },
  medicines: {
    label: "Medicines",
    suggestions: [
      "When should I take this?",
      "What are the side effects?",
      "Remind me about refills",
      "Can I take this with food?",
    ],
  },
  reports: {
    label: "Reports",
    suggestions: [
      "Explain my latest report",
      "Is this normal?",
      "What should I ask my doctor about this?",
      "Compare to my last report",
    ],
  },
  insurance: {
    label: "Insurance & TPA",
    suggestions: [
      "What is a TPA?",
      "How do cashless claims work?",
      "Check my claim status",
      "What's my health card ID?",
    ],
  },
  emergency: {
    label: "Emergency",
    suggestions: ["I'm having chest pain", "Call my emergency contact", "What's the nearest hospital?", "Show my allergies"],
  },
};

export function getPageAiContext(mode: UserMode, view: NavId | PatientNavId): PageAiContext {
  if (mode === "doctor") return DOCTOR_CONTEXT[view as NavId] ?? DOCTOR_CONTEXT.overview;
  return PATIENT_CONTEXT[view as PatientNavId] ?? PATIENT_CONTEXT.home;
}
