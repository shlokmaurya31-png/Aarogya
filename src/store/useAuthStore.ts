import { create } from "zustand";
import { persist } from "zustand/middleware";
import { usePatientStore } from "@/store/usePatientStore";
import type { AuthUser, VerificationApplication } from "@/types";

type ActionResult = { ok: true } | { ok: false; error: string };

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "");
  return letters.join("") || "AA";
}

function nextId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

const ADMIN_CREDENTIALS = { email: "admin@aarogya.ai", password: "admin123" };

const SEED_APPLICATIONS: VerificationApplication[] = [
  {
    id: "app-seed-1",
    role: "doctor",
    name: "Dr. Ananya Rao",
    email: "ananya.rao@example.com",
    specialty: "Endocrinology",
    registrationId: "MCI-KA-77410",
    facility: "Manipal Hospital, Bengaluru",
    proofFileName: "mci-registration-ananya-rao.pdf",
    submittedAt: "2026-08-01",
    status: "pending",
  },
  {
    id: "app-seed-2",
    role: "doctor",
    name: "Dr. Vikram Nair",
    email: "vikram.nair@example.com",
    specialty: "Orthopedics",
    registrationId: "MCI-KL-51982",
    facility: "Aster Medcity, Kochi",
    proofFileName: "medical-license-vikram-nair.pdf",
    submittedAt: "2026-07-28",
    status: "pending",
  },
  {
    id: "app-seed-3",
    role: "lab",
    name: "Dr Lal PathLabs, Pune Branch",
    email: "pune.branch@lalpathlabs.example.com",
    registrationId: "NABL-MH-20394",
    facility: "Dr Lal PathLabs, Camp Road, Pune",
    proofFileName: "nabl-accreditation-lalpathlabs-pune.pdf",
    submittedAt: "2026-07-30",
    status: "pending",
  },
];

interface SignUpPatientInput {
  name: string;
  email: string;
  phone: string;
  password: string;
}

interface SignUpDoctorInput {
  name: string;
  email: string;
  phone: string;
  specialty: string;
  registrationId: string;
  facility: string;
  password: string;
  proofFile: File;
}

interface SignUpLabInput {
  name: string;
  email: string;
  phone: string;
  registrationId: string;
  facility: string;
  password: string;
  proofFile: File;
}

export interface ProfileUpdate {
  name: string;
  email: string;
  phone?: string;
  specialty?: string;
  registrationId?: string;
  facility?: string;
}

interface AuthState {
  user: AuthUser | null;
  hasHydrated: boolean;
  verificationApplications: VerificationApplication[];
  setHasHydrated: (v: boolean) => void;
  signInPatient: (email: string, password: string) => ActionResult;
  signInDoctor: (email: string, password: string) => ActionResult;
  signInLab: (email: string, password: string) => ActionResult;
  signInAdmin: (email: string, password: string) => ActionResult;
  signUpPatient: (input: SignUpPatientInput) => ActionResult;
  signUpDoctor: (input: SignUpDoctorInput) => ActionResult;
  signUpLab: (input: SignUpLabInput) => ActionResult;
  updateProfile: (updates: ProfileUpdate) => ActionResult;
  logout: () => void;
  approveApplication: (id: string) => void;
  rejectApplication: (id: string) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      hasHydrated: false,
      verificationApplications: SEED_APPLICATIONS,
      setHasHydrated: (v) => set({ hasHydrated: v }),

      signInPatient: (email, password) => {
        if (!email.trim() || password.length < 4) {
          return { ok: false, error: "Enter a valid email and password." };
        }
        const handle = email.split("@")[0]?.replace(/[._]/g, " ") || "Patient";
        set({
          user: {
            id: nextId("pat"),
            role: "patient",
            name: handle,
            email,
            avatarInitials: initials(handle),
          },
        });
        return { ok: true };
      },

      signInDoctor: (email, password) => {
        if (!email.trim() || password.length < 4) {
          return { ok: false, error: "Enter a valid email and password." };
        }
        const handle = email.split("@")[0]?.replace(/[._]/g, " ") || "Doctor";
        set({
          user: {
            id: nextId("doc"),
            role: "doctor",
            name: `Dr. ${handle}`,
            email,
            avatarInitials: initials(handle),
            verificationStatus: "verified",
          },
        });
        return { ok: true };
      },

      signInLab: (email, password) => {
        if (!email.trim() || password.length < 4) {
          return { ok: false, error: "Enter a valid email and password." };
        }
        const handle = email.split("@")[0]?.replace(/[._]/g, " ") || "Lab";
        set({
          user: {
            id: nextId("lab"),
            role: "lab",
            name: handle,
            email,
            avatarInitials: initials(handle),
            verificationStatus: "verified",
          },
        });
        return { ok: true };
      },

      signInAdmin: (email, password) => {
        if (
          email.trim().toLowerCase() !== ADMIN_CREDENTIALS.email ||
          password !== ADMIN_CREDENTIALS.password
        ) {
          return { ok: false, error: "Invalid admin credentials." };
        }
        set({
          user: {
            id: "admin-1",
            role: "admin",
            name: "Platform Admin",
            email,
            avatarInitials: "PA",
          },
        });
        return { ok: true };
      },

      signUpPatient: ({ name, email, phone, password }) => {
        if (!name.trim() || !email.trim() || !phone.trim() || password.length < 6) {
          return { ok: false, error: "Fill every field. Password needs at least 6 characters." };
        }
        set({
          user: {
            id: nextId("pat"),
            role: "patient",
            name,
            email,
            phone,
            avatarInitials: initials(name),
          },
        });
        return { ok: true };
      },

      signUpDoctor: ({ name, email, phone, specialty, registrationId, facility, password, proofFile }) => {
        if (
          !name.trim() ||
          !email.trim() ||
          !phone.trim() ||
          !specialty.trim() ||
          !registrationId.trim() ||
          !facility.trim() ||
          password.length < 6
        ) {
          return { ok: false, error: "Fill every field. Password needs at least 6 characters." };
        }
        if (!proofFile) {
          return { ok: false, error: "Upload proof of practice to continue." };
        }
        const application: VerificationApplication = {
          id: nextId("app"),
          role: "doctor",
          name,
          email,
          specialty,
          registrationId,
          facility,
          proofFileName: proofFile.name,
          submittedAt: new Date().toISOString().slice(0, 10),
          status: "pending",
        };
        set((s) => ({
          verificationApplications: [application, ...s.verificationApplications],
          user: {
            id: nextId("doc"),
            role: "doctor",
            name,
            email,
            phone,
            avatarInitials: initials(name),
            specialty,
            registrationId,
            facility,
            verificationStatus: "pending",
          },
        }));
        return { ok: true };
      },

      signUpLab: ({ name, email, phone, registrationId, facility, password, proofFile }) => {
        if (
          !name.trim() ||
          !email.trim() ||
          !phone.trim() ||
          !registrationId.trim() ||
          !facility.trim() ||
          password.length < 6
        ) {
          return { ok: false, error: "Fill every field. Password needs at least 6 characters." };
        }
        if (!proofFile) {
          return { ok: false, error: "Upload proof of accreditation to continue." };
        }
        const application: VerificationApplication = {
          id: nextId("app"),
          role: "lab",
          name,
          email,
          registrationId,
          facility,
          proofFileName: proofFile.name,
          submittedAt: new Date().toISOString().slice(0, 10),
          status: "pending",
        };
        set((s) => ({
          verificationApplications: [application, ...s.verificationApplications],
          user: {
            id: nextId("lab"),
            role: "lab",
            name,
            email,
            phone,
            avatarInitials: initials(name),
            registrationId,
            facility,
            verificationStatus: "pending",
          },
        }));
        return { ok: true };
      },

      updateProfile: (updates) => {
        if (!updates.name.trim() || !updates.email.trim()) {
          return { ok: false, error: "Name and email can't be empty." };
        }
        set((s) => {
          if (!s.user) return {};
          return {
            user: {
              ...s.user,
              ...updates,
              avatarInitials: initials(updates.name),
            },
          };
        });
        return { ok: true };
      },

      logout: () => {
        usePatientStore.getState().reset();
        set({ user: null });
      },

      approveApplication: (id) =>
        set((s) => ({
          verificationApplications: s.verificationApplications.map((a) =>
            a.id === id ? { ...a, status: "verified" as const } : a
          ),
        })),

      rejectApplication: (id) =>
        set((s) => ({
          verificationApplications: s.verificationApplications.map((a) =>
            a.id === id ? { ...a, status: "rejected" as const } : a
          ),
        })),
    }),
    {
      name: "aarogya-auth",
      partialize: (s) => ({ user: s.user, verificationApplications: s.verificationApplications }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    }
  )
);
