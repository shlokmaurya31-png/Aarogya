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
import { AiAssistantWidget } from "@/components/ai/AiAssistantWidget";
import { useTranslation } from "@/hooks/useTranslation";
import { useUiStore } from "@/store/useUiStore";
import { useAuthStore } from "@/store/useAuthStore";
import { usePatientStore } from "@/store/usePatientStore";

export default function DashboardPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const isDoctor = useUiStore((s) => s.mode === "doctor");
  const activePatientView = useUiStore((s) => s.activePatientView);
  const setMode = useUiStore((s) => s.setMode);
  const user = useAuthStore((s) => s.user);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const patientProfile = usePatientStore((s) => s.profile);
  const showWidget = isDoctor || activePatientView !== "home";
  const { t } = useTranslation();

  useEffect(() => {
    if (!hasHydrated) return;
    if (!user) {
      router.replace("/login");
      return;
    }
    if (user.role === "admin" || user.role === "staff") {
      router.replace("/admin");
      return;
    }
    if (user.role === "lab") {
      router.replace("/lab");
      return;
    }
    if (user.role === "hospital") {
      router.replace("/hospital");
      return;
    }
    if (user.role === "patient" && !patientProfile) {
      router.replace("/onboarding");
      return;
    }
    setMode(user.role);
  }, [hasHydrated, user, patientProfile, router, setMode]);

  const blockedForOnboarding = user?.role === "patient" && !patientProfile;

  if (!hasHydrated || !user || user.role === "admin" || user.role === "staff" || user.role === "lab" || user.role === "hospital" || blockedForOnboarding) {
    return <div className="flex min-h-screen items-center justify-center bg-ink text-text-tertiary">{t("common.loading")}</div>;
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
      {!loading && showWidget && <AiAssistantWidget />}
      <ToastViewport />
      <LanguageDirEffect />
    </>
  );
}
