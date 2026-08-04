"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { LoadingScreen } from "@/components/shared/LoadingScreen";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { LanguageDirEffect } from "@/components/shared/LanguageDirEffect";
import { TopBar } from "@/components/navigation/TopBar";
import { ViewSwitcher } from "@/components/views/ViewSwitcher";
import { PatientViewSwitcher } from "@/components/views/PatientViewSwitcher";
import { useUiStore } from "@/store/useUiStore";
import { useAuthStore } from "@/store/useAuthStore";

export default function DashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const isDoctor = useUiStore((s) => s.mode === "doctor");
  const setMode = useUiStore((s) => s.setMode);
  const user = useAuthStore((s) => s.user);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);

  useEffect(() => {
    if (!hasHydrated) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (user.role === "admin") {
      router.replace("/admin");
      return;
    }
    if (user.role === "lab") {
      router.replace("/lab");
      return;
    }
    setMode(user.role);
  }, [hasHydrated, user, router, setMode]);

  if (!hasHydrated || !user || user.role === "admin" || user.role === "lab") {
    return <div className="flex min-h-screen items-center justify-center bg-ink text-text-tertiary">Loading…</div>;
  }

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
      <LanguageDirEffect />
    </>
  );
}
