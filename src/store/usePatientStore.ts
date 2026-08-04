import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  Appointment,
  BodySystem,
  EmergencyContact,
  InsuranceClaim,
  NotificationItem,
  PatientOnboardingInput,
  PatientProfile,
  Prescription,
  ReportDoc,
  TimelineEvent,
  VitalSeries,
} from "@/types";

function randomCode(prefix: string, len = 6) {
  return `${prefix}-${Math.random().toString(36).slice(2, 2 + len).toUpperCase()}`;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "");
  return letters.join("") || "AA";
}

function buildProfile(name: string, input: PatientOnboardingInput): PatientProfile {
  const hasInsurance = Boolean(input.insuranceProvider?.trim());
  return {
    name,
    patientId: `AAR-${randomCode("", 4)}-${randomCode("", 4)}`,
    hospitalId: `SELF-${randomCode("", 6)}`,
    age: input.age,
    gender: input.gender,
    height: input.height,
    weight: input.weight,
    bloodGroup: input.bloodGroup,
    allergies: input.allergies.length ? input.allergies : ["None reported"],
    insurance: hasInsurance ? input.insuranceProvider!.trim() : "Not added yet",
    emergencyContact: `${input.emergencyContactName} (${input.emergencyContactPhone})`,
    abhaNumber: "Not linked yet",
    aadhaarLinked: false,
    ayushmanBharat: "not-eligible",
    avatarInitials: initials(name),
    tpa: hasInsurance
      ? {
          name: "Medi Assist Insurance TPA",
          healthCardId: `MAI-${randomCode("", 8)}`,
          policyNumber: `POL-${randomCode("", 8)}`,
          helpline: "1800-425-9449",
        }
      : {
          name: "Not assigned yet",
          healthCardId: "Not assigned",
          policyNumber: "Not assigned",
          helpline: "Add insurance in Settings",
        },
  };
}

interface PatientDataState {
  profile: PatientProfile | null;
  vitals: VitalSeries[];
  bodySystems: BodySystem[];
  timeline: TimelineEvent[];
  appointments: Appointment[];
  reports: ReportDoc[];
  notifications: NotificationItem[];
  prescriptions: Prescription[];
  insuranceClaims: InsuranceClaim[];
  emergencyContacts: EmergencyContact[];
  completeOnboarding: (name: string, input: PatientOnboardingInput) => void;
  updateInsuranceProvider: (provider: string) => void;
  addReport: (report: ReportDoc) => void;
  addNotification: (notification: NotificationItem) => void;
  reset: () => void;
}

const EMPTY_STATE = {
  profile: null,
  vitals: [],
  bodySystems: [],
  timeline: [],
  appointments: [],
  reports: [],
  notifications: [],
  prescriptions: [],
  insuranceClaims: [],
  emergencyContacts: [],
} satisfies Omit<
  PatientDataState,
  "completeOnboarding" | "updateInsuranceProvider" | "addReport" | "addNotification" | "reset"
>;

export const usePatientStore = create<PatientDataState>()(
  persist(
    (set) => ({
      ...EMPTY_STATE,

      completeOnboarding: (name, input) => {
        const profile = buildProfile(name, input);
        set({
          ...EMPTY_STATE,
          profile,
          emergencyContacts: [
            {
              id: "self-ec1",
              name: input.emergencyContactName,
              relation: "Emergency contact",
              phone: input.emergencyContactPhone,
              priority: 1,
            },
          ],
        });
      },

      updateInsuranceProvider: (provider) =>
        set((s) => {
          if (!s.profile) return {};
          const trimmed = provider.trim();
          return {
            profile: {
              ...s.profile,
              insurance: trimmed || "Not added yet",
              tpa: trimmed
                ? {
                    name: "Medi Assist Insurance TPA",
                    healthCardId: `MAI-${randomCode("", 8)}`,
                    policyNumber: `POL-${randomCode("", 8)}`,
                    helpline: "1800-425-9449",
                  }
                : {
                    name: "Not assigned yet",
                    healthCardId: "Not assigned",
                    policyNumber: "Not assigned",
                    helpline: "Add insurance in Settings",
                  },
            },
          };
        }),

      addReport: (report) => set((s) => ({ reports: [report, ...s.reports] })),
      addNotification: (notification) => set((s) => ({ notifications: [notification, ...s.notifications] })),
      reset: () => set({ ...EMPTY_STATE }),
    }),
    { name: "aarogya-patient-data" }
  )
);
