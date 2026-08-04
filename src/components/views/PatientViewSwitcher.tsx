"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useUiStore } from "@/store/useUiStore";
import { PatientHomeView } from "./patient/PatientHomeView";
import { PatientAppointmentsView } from "./patient/PatientAppointmentsView";
import { PatientMedicinesView } from "./patient/PatientMedicinesView";
import { PatientReportsView } from "./patient/PatientReportsView";
import { PatientInsuranceView } from "./patient/PatientInsuranceView";
import { EmergencyView } from "./EmergencyView";
import type { PatientNavId } from "@/types";

const VIEWS: Record<PatientNavId, React.ComponentType> = {
  home: PatientHomeView,
  appointments: PatientAppointmentsView,
  medicines: PatientMedicinesView,
  reports: PatientReportsView,
  insurance: PatientInsuranceView,
  emergency: EmergencyView,
};

export function PatientViewSwitcher() {
  const activeView = useUiStore((s) => s.activePatientView);
  const ActiveComponent = VIEWS[activeView];

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={activeView}
        initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
        animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
        exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        <ActiveComponent />
      </motion.div>
    </AnimatePresence>
  );
}
