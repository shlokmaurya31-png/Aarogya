import { create } from "zustand";
import { persist } from "zustand/middleware";
import { useBedBookingStore } from "@/store/useBedBookingStore";
import type { BedCategory, HospitalAdmission, HospitalDoctorEntry, HospitalStaffMember } from "@/types";

type ActionResult = { ok: true } | { ok: false; error: string };

function nextId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function freeCountFor(hospitalId: string, ward: BedCategory): number | null {
  const hospital = useBedBookingStore.getState().hospitals.find((h) => h.id === hospitalId);
  if (!hospital) return null;
  return ward === "emergency" ? hospital.emergencyBeds : ward === "icu" ? hospital.icuBeds : hospital.generalBeds;
}

function seedDoctors(): HospitalDoctorEntry[] {
  return [
    {
      id: nextId("doc"),
      name: "Dr. Nikhil Bhatt",
      specialty: "Cardiology",
      qualification: "MBBS, MD (Cardiology)",
      registrationId: "MCI-MH-71230",
      shift: "morning",
      onDuty: true,
      phone: "+91 98221 40011",
    },
    {
      id: nextId("doc"),
      name: "Dr. Priya Menon",
      specialty: "Orthopedics",
      qualification: "MBBS, MS (Orthopedics)",
      registrationId: "MCI-KA-51882",
      shift: "evening",
      onDuty: true,
      phone: "+91 98221 40022",
    },
    {
      id: nextId("doc"),
      name: "Dr. Farhan Sheikh",
      specialty: "General Medicine",
      qualification: "MBBS, MD (Medicine)",
      registrationId: "MCI-MH-63321",
      shift: "night",
      onDuty: false,
      phone: "+91 98221 40033",
    },
    {
      id: nextId("doc"),
      name: "Dr. Kavita Deshmukh",
      specialty: "Pediatrics",
      qualification: "MBBS, MD (Pediatrics)",
      registrationId: "MCI-MH-84492",
      shift: "morning",
      onDuty: true,
      phone: "+91 98221 40044",
    },
  ];
}

function seedStaff(): HospitalStaffMember[] {
  return [
    { id: nextId("stf"), name: "Sunita Pillai", role: "nurse", ward: "ICU", shift: "morning", onDuty: true, phone: "+91 98222 10011" },
    { id: nextId("stf"), name: "Ramesh Yadav", role: "nurse", ward: "General Ward", shift: "morning", onDuty: true, phone: "+91 98222 10022" },
    { id: nextId("stf"), name: "Ayesha Khan", role: "nurse", ward: "Emergency", shift: "night", onDuty: true, phone: "+91 98222 10033" },
    { id: nextId("stf"), name: "Vikram Solanki", role: "technician", ward: "Radiology", shift: "morning", onDuty: true, phone: "+91 98222 10044" },
    { id: nextId("stf"), name: "Meena Joshi", role: "receptionist", ward: "Front Desk", shift: "morning", onDuty: true, phone: "+91 98222 10055" },
    { id: nextId("stf"), name: "Suresh Naik", role: "ward-boy", ward: "General Ward", shift: "evening", onDuty: false, phone: "+91 98222 10066" },
    { id: nextId("stf"), name: "Divya Iyer", role: "pharmacist", ward: "Pharmacy", shift: "morning", onDuty: true, phone: "+91 98222 10077" },
  ];
}

function seedAdmissions(doctors: HospitalDoctorEntry[]): HospitalAdmission[] {
  const doctorFor = (specialty: string) => doctors.find((d) => d.specialty === specialty) ?? doctors[0];
  return [
    {
      id: nextId("adm"),
      patientName: "Rohit Kadam",
      age: 58,
      gender: "Male",
      ward: "icu",
      bedLabel: "ICU-1",
      doctorId: doctorFor("Cardiology").id,
      doctorName: doctorFor("Cardiology").name,
      diagnosis: "Post-cardiac observation",
      admittedAt: "2026-08-03",
      status: "critical",
    },
    {
      id: nextId("adm"),
      patientName: "Sneha Kulkarni",
      age: 34,
      gender: "Female",
      ward: "icu",
      bedLabel: "ICU-2",
      doctorId: doctorFor("General Medicine").id,
      doctorName: doctorFor("General Medicine").name,
      diagnosis: "Severe dengue, platelet monitoring",
      admittedAt: "2026-08-04",
      status: "critical",
    },
    {
      id: nextId("adm"),
      patientName: "Arvind Rao",
      age: 45,
      gender: "Male",
      ward: "emergency",
      bedLabel: "ER-1",
      doctorId: doctorFor("General Medicine").id,
      doctorName: doctorFor("General Medicine").name,
      diagnosis: "Road traffic accident, fracture stabilization",
      admittedAt: "2026-08-05",
      status: "admitted",
    },
    {
      id: nextId("adm"),
      patientName: "Farheen Ansari",
      age: 27,
      gender: "Female",
      ward: "emergency",
      bedLabel: "ER-2",
      doctorId: doctorFor("Orthopedics").id,
      doctorName: doctorFor("Orthopedics").name,
      diagnosis: "Acute appendicitis, pre-op",
      admittedAt: "2026-08-05",
      status: "admitted",
    },
    {
      id: nextId("adm"),
      patientName: "Manoj Tiwari",
      age: 62,
      gender: "Male",
      ward: "general",
      bedLabel: "GW-4",
      doctorId: doctorFor("Cardiology").id,
      doctorName: doctorFor("Cardiology").name,
      diagnosis: "Hypertension management",
      admittedAt: "2026-08-02",
      status: "admitted",
    },
    {
      id: nextId("adm"),
      patientName: "Ila Bhatt",
      age: 8,
      gender: "Female",
      ward: "general",
      bedLabel: "GW-5",
      doctorId: doctorFor("Pediatrics").id,
      doctorName: doctorFor("Pediatrics").name,
      diagnosis: "Viral fever, hydration therapy",
      admittedAt: "2026-08-05",
      status: "admitted",
    },
    {
      id: nextId("adm"),
      patientName: "Deepak Chauhan",
      age: 51,
      gender: "Male",
      ward: "general",
      bedLabel: "GW-6",
      doctorId: doctorFor("General Medicine").id,
      doctorName: doctorFor("General Medicine").name,
      diagnosis: "Post-op recovery",
      admittedAt: "2026-08-01",
      status: "admitted",
    },
  ];
}

interface AdmitInput {
  patientName: string;
  age: number;
  gender: string;
  ward: BedCategory;
  doctorId: string;
  doctorName: string;
  diagnosis: string;
}

interface HospitalOpsState {
  doctorsByHospital: Record<string, HospitalDoctorEntry[]>;
  staffByHospital: Record<string, HospitalStaffMember[]>;
  admissionsByHospital: Record<string, HospitalAdmission[]>;
  ensureSeeded: (hospitalId: string) => void;
  addDoctor: (hospitalId: string, doctor: Omit<HospitalDoctorEntry, "id">) => void;
  updateDoctor: (hospitalId: string, doctorId: string, updates: Omit<HospitalDoctorEntry, "id" | "onDuty">) => void;
  removeDoctor: (hospitalId: string, doctorId: string) => void;
  toggleDoctorDuty: (hospitalId: string, doctorId: string) => void;
  addStaff: (hospitalId: string, staff: Omit<HospitalStaffMember, "id">) => void;
  updateStaff: (hospitalId: string, staffId: string, updates: Omit<HospitalStaffMember, "id" | "onDuty">) => void;
  removeStaff: (hospitalId: string, staffId: string) => void;
  toggleStaffDuty: (hospitalId: string, staffId: string) => void;
  admitPatient: (hospitalId: string, input: AdmitInput) => ActionResult;
  dischargePatient: (hospitalId: string, admissionId: string) => void;
  transferPatient: (hospitalId: string, admissionId: string, newWard: BedCategory) => ActionResult;
  setAdmissionCritical: (hospitalId: string, admissionId: string, critical: boolean) => void;
}

const WARD_PREFIX: Record<BedCategory, string> = { emergency: "ER", icu: "ICU", general: "GW" };

export const useHospitalOpsStore = create<HospitalOpsState>()(
  persist(
    (set, get) => ({
      doctorsByHospital: {},
      staffByHospital: {},
      admissionsByHospital: {},

      ensureSeeded: (hospitalId) => {
        if (get().doctorsByHospital[hospitalId]) return;
        const doctors = seedDoctors();
        set((s) => ({
          doctorsByHospital: { ...s.doctorsByHospital, [hospitalId]: doctors },
          staffByHospital: { ...s.staffByHospital, [hospitalId]: seedStaff() },
          admissionsByHospital: { ...s.admissionsByHospital, [hospitalId]: seedAdmissions(doctors) },
        }));
      },

      addDoctor: (hospitalId, doctor) =>
        set((s) => ({
          doctorsByHospital: {
            ...s.doctorsByHospital,
            [hospitalId]: [{ ...doctor, id: nextId("doc") }, ...(s.doctorsByHospital[hospitalId] ?? [])],
          },
        })),

      updateDoctor: (hospitalId, doctorId, updates) =>
        set((s) => ({
          doctorsByHospital: {
            ...s.doctorsByHospital,
            [hospitalId]: (s.doctorsByHospital[hospitalId] ?? []).map((d) =>
              d.id === doctorId ? { ...d, ...updates } : d
            ),
          },
        })),

      removeDoctor: (hospitalId, doctorId) =>
        set((s) => ({
          doctorsByHospital: {
            ...s.doctorsByHospital,
            [hospitalId]: (s.doctorsByHospital[hospitalId] ?? []).filter((d) => d.id !== doctorId),
          },
        })),

      toggleDoctorDuty: (hospitalId, doctorId) =>
        set((s) => ({
          doctorsByHospital: {
            ...s.doctorsByHospital,
            [hospitalId]: (s.doctorsByHospital[hospitalId] ?? []).map((d) =>
              d.id === doctorId ? { ...d, onDuty: !d.onDuty } : d
            ),
          },
        })),

      addStaff: (hospitalId, staff) =>
        set((s) => ({
          staffByHospital: {
            ...s.staffByHospital,
            [hospitalId]: [{ ...staff, id: nextId("stf") }, ...(s.staffByHospital[hospitalId] ?? [])],
          },
        })),

      updateStaff: (hospitalId, staffId, updates) =>
        set((s) => ({
          staffByHospital: {
            ...s.staffByHospital,
            [hospitalId]: (s.staffByHospital[hospitalId] ?? []).map((m) =>
              m.id === staffId ? { ...m, ...updates } : m
            ),
          },
        })),

      removeStaff: (hospitalId, staffId) =>
        set((s) => ({
          staffByHospital: {
            ...s.staffByHospital,
            [hospitalId]: (s.staffByHospital[hospitalId] ?? []).filter((m) => m.id !== staffId),
          },
        })),

      toggleStaffDuty: (hospitalId, staffId) =>
        set((s) => ({
          staffByHospital: {
            ...s.staffByHospital,
            [hospitalId]: (s.staffByHospital[hospitalId] ?? []).map((m) =>
              m.id === staffId ? { ...m, onDuty: !m.onDuty } : m
            ),
          },
        })),

      admitPatient: (hospitalId, input) => {
        const free = freeCountFor(hospitalId, input.ward);
        if (free === null) return { ok: false, error: "Hospital record not found." };
        if (free <= 0) return { ok: false, error: "No beds available in that ward right now." };

        const existing = get().admissionsByHospital[hospitalId] ?? [];
        const wardOccupancy = existing.filter((a) => a.ward === input.ward && a.status !== "discharged").length;
        const admission: HospitalAdmission = {
          ...input,
          id: nextId("adm"),
          bedLabel: `${WARD_PREFIX[input.ward]}-${wardOccupancy + 1}`,
          admittedAt: new Date().toISOString().slice(0, 10),
          status: "admitted",
        };

        useBedBookingStore.getState().setBedCount(hospitalId, input.ward, free - 1);
        set((s) => ({
          admissionsByHospital: {
            ...s.admissionsByHospital,
            [hospitalId]: [admission, ...existing],
          },
        }));
        return { ok: true };
      },

      dischargePatient: (hospitalId, admissionId) => {
        const admission = (get().admissionsByHospital[hospitalId] ?? []).find((a) => a.id === admissionId);
        if (!admission || admission.status === "discharged") return;

        const free = freeCountFor(hospitalId, admission.ward);
        if (free !== null) {
          useBedBookingStore.getState().setBedCount(hospitalId, admission.ward, free + 1);
        }

        set((s) => ({
          admissionsByHospital: {
            ...s.admissionsByHospital,
            [hospitalId]: (s.admissionsByHospital[hospitalId] ?? []).map((a) =>
              a.id === admissionId
                ? { ...a, status: "discharged" as const, dischargedAt: new Date().toISOString().slice(0, 10) }
                : a
            ),
          },
        }));
      },

      transferPatient: (hospitalId, admissionId, newWard) => {
        const admission = (get().admissionsByHospital[hospitalId] ?? []).find((a) => a.id === admissionId);
        if (!admission || admission.status === "discharged") return { ok: false, error: "Patient not found." };
        if (admission.ward === newWard) return { ok: false, error: "Patient is already in that ward." };

        const free = freeCountFor(hospitalId, newWard);
        if (free === null) return { ok: false, error: "Hospital record not found." };
        if (free <= 0) return { ok: false, error: "No beds available in that ward right now." };

        const wardOccupancy = (get().admissionsByHospital[hospitalId] ?? []).filter(
          (a) => a.ward === newWard && a.status !== "discharged"
        ).length;

        useBedBookingStore.getState().setBedCount(hospitalId, admission.ward, (freeCountFor(hospitalId, admission.ward) ?? 0) + 1);
        useBedBookingStore.getState().setBedCount(hospitalId, newWard, free - 1);

        set((s) => ({
          admissionsByHospital: {
            ...s.admissionsByHospital,
            [hospitalId]: (s.admissionsByHospital[hospitalId] ?? []).map((a) =>
              a.id === admissionId
                ? { ...a, ward: newWard, bedLabel: `${WARD_PREFIX[newWard]}-${wardOccupancy + 1}` }
                : a
            ),
          },
        }));
        return { ok: true };
      },

      setAdmissionCritical: (hospitalId, admissionId, critical) =>
        set((s) => ({
          admissionsByHospital: {
            ...s.admissionsByHospital,
            [hospitalId]: (s.admissionsByHospital[hospitalId] ?? []).map((a) =>
              a.id === admissionId && a.status !== "discharged"
                ? { ...a, status: critical ? "critical" : "admitted" }
                : a
            ),
          },
        })),
    }),
    { name: "aarogya-hospital-ops" }
  )
);
