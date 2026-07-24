"use client";

import { SectionHeader } from "@/components/ui/SectionHeader";
import { ClinicalBrief } from "@/components/dashboard/ClinicalBrief";
import { SystemsCard } from "@/components/dashboard/SystemsCard";
import { PatientCard } from "@/components/patient/PatientCard";
import { VitalsGrid } from "@/components/charts/VitalsGrid";
import { HealthTimeline } from "@/components/timeline/HealthTimeline";
import { NotificationsList } from "@/components/dashboard/NotificationsList";
import { useTranslation } from "@/hooks/useTranslation";

export function OverviewView() {
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow={t("overview.eyebrow")}
        title="Meera Kulkarni · 42F"
        subtitle="T2DM (E11.65) · Essential HTN (I10) · Osteopenia (M85.8) · Last visit 14 Jun 2026"
        action={
          <div className="flex items-center gap-2 rounded-full border border-hairline bg-card px-4 py-2 text-[12px]">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald" />
            Risk stratification: <span className="font-medium text-emerald">Low</span>
          </div>
        }
      />

      <VitalsGrid />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <ClinicalBrief />
        </div>
        <SystemsCard />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <HealthTimeline />
        </div>
        <div className="space-y-4">
          <PatientCard />
          <NotificationsList />
        </div>
      </div>
    </div>
  );
}
