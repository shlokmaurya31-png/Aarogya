import { create } from "zustand";
import { hospitalBeds } from "@/lib/mock-data";
import type { BedBooking, BedCategory, HospitalBedAvailability } from "@/types";

type BookResult = { ok: true; booking: BedBooking } | { ok: false; error: string };

function bedsFor(hospital: HospitalBedAvailability, category: BedCategory): number {
  switch (category) {
    case "emergency":
      return hospital.emergencyBeds;
    case "icu":
      return hospital.icuBeds;
    case "general":
      return hospital.generalBeds;
  }
}

export function capacityFor(hospital: HospitalBedAvailability, category: BedCategory): number {
  switch (category) {
    case "emergency":
      return hospital.emergencyCapacity;
    case "icu":
      return hospital.icuCapacity;
    case "general":
      return hospital.generalCapacity;
  }
}

function adjustBeds(
  hospital: HospitalBedAvailability,
  category: BedCategory,
  delta: number
): HospitalBedAvailability {
  switch (category) {
    case "emergency":
      return { ...hospital, emergencyBeds: hospital.emergencyBeds + delta };
    case "icu":
      return { ...hospital, icuBeds: hospital.icuBeds + delta };
    case "general":
      return { ...hospital, generalBeds: hospital.generalBeds + delta };
  }
}

function generateCode() {
  return `AAR-BED-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

interface BedBookingState {
  hospitals: HospitalBedAvailability[];
  activeBooking: BedBooking | null;
  bookBed: (hospitalId: string, category: BedCategory, patientName: string) => BookResult;
  cancelBooking: () => void;
  registerHospital: (hospital: HospitalBedAvailability) => void;
  setBedCount: (hospitalId: string, category: BedCategory, count: number) => void;
}

export const useBedBookingStore = create<BedBookingState>((set, get) => ({
  hospitals: hospitalBeds,
  activeBooking: null,

  bookBed: (hospitalId, category, patientName) => {
    const hospital = get().hospitals.find((h) => h.id === hospitalId);
    if (!hospital) return { ok: false, error: "Hospital not found." };
    if (bedsFor(hospital, category) <= 0) {
      return { ok: false, error: "No beds available in that category right now." };
    }

    const booking: BedBooking = {
      id: `booking-${Date.now()}`,
      hospitalId,
      hospitalName: hospital.name,
      category,
      patientName,
      confirmationCode: generateCode(),
      bookedAt: new Date().toISOString(),
    };

    set((s) => ({
      hospitals: s.hospitals.map((h) => (h.id === hospitalId ? adjustBeds(h, category, -1) : h)),
      activeBooking: booking,
    }));

    return { ok: true, booking };
  },

  cancelBooking: () =>
    set((s) => {
      const active = s.activeBooking;
      if (!active) return {};
      return {
        hospitals: s.hospitals.map((h) =>
          h.id === active.hospitalId ? adjustBeds(h, active.category, 1) : h
        ),
        activeBooking: null,
      };
    }),

  registerHospital: (hospital) =>
    set((s) => (s.hospitals.some((h) => h.id === hospital.id) ? s : { hospitals: [hospital, ...s.hospitals] })),

  setBedCount: (hospitalId, category, count) =>
    set((s) => ({
      hospitals: s.hospitals.map((h) => {
        if (h.id !== hospitalId) return h;
        const next = Math.min(Math.max(0, count), capacityFor(h, category));
        switch (category) {
          case "emergency":
            return { ...h, emergencyBeds: next };
          case "icu":
            return { ...h, icuBeds: next };
          case "general":
            return { ...h, generalBeds: next };
        }
      }),
    })),
}));
