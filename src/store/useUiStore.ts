import { create } from "zustand";
import type { NavId, PatientNavId, UserMode } from "@/types";

interface UiState {
  mode: UserMode;
  activeView: NavId;
  activePatientView: PatientNavId;
  setMode: (mode: UserMode) => void;
  setActiveView: (view: NavId) => void;
  setActivePatientView: (view: PatientNavId) => void;
}

export const useUiStore = create<UiState>((set) => ({
  mode: "patient",
  activeView: "overview",
  activePatientView: "home",
  setMode: (mode) => set({ mode }),
  setActiveView: (view) => set({ activeView: view }),
  setActivePatientView: (view) => set({ activePatientView: view }),
}));
