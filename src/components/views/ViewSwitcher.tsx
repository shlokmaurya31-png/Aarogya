"use client";

import { AnimatePresence, motion } from "framer-motion";
import { useUiStore } from "@/store/useUiStore";
import { OverviewView } from "./OverviewView";
import { AppointmentsView } from "./AppointmentsView";
import { MedicalHistoryView } from "./MedicalHistoryView";
import { ReportsView } from "./ReportsView";
import { LabResultsView } from "./LabResultsView";
import { PrescriptionsView } from "./PrescriptionsView";
import { InsuranceView } from "./InsuranceView";
import { EmergencyView } from "./EmergencyView";
import type { NavId } from "@/types";

const VIEWS: Record<NavId, React.ComponentType> = {
  overview: OverviewView,
  appointments: AppointmentsView,
  history: MedicalHistoryView,
  reports: ReportsView,
  labs: LabResultsView,
  prescriptions: PrescriptionsView,
  insurance: InsuranceView,
  emergency: EmergencyView,
};

export function ViewSwitcher() {
  const activeView = useUiStore((s) => s.activeView);
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
