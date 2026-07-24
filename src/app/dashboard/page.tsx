"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { LoadingScreen } from "@/components/shared/LoadingScreen";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { TopBar } from "@/components/navigation/TopBar";
import { ViewSwitcher } from "@/components/views/ViewSwitcher";
import { PatientViewSwitcher } from "@/components/views/PatientViewSwitcher";
import { useUiStore } from "@/store/useUiStore";

export default function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const isDoctor = useUiStore((s) => s.mode === "doctor");

  return (
    <>
      {loading && <LoadingScreen onComplete={() => setLoading(false)} />}

      <AnimatePresence>
        {!loading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="min-h-screen w-full bg-ink text-text-primary"
          >
            <TopBar />
            <main className="mx-auto max-w-[1500px] px-5 py-6">
              {isDoctor ? <ViewSwitcher /> : <PatientViewSwitcher />}
            </main>
          </motion.div>
        )}
      </AnimatePresence>
      <ToastViewport />
    </>
  );
}
