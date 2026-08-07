"use client";

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { timeline } from "@/lib/mock-data";
import { TIMELINE_TYPE_META, formatEventDate } from "@/lib/timeline-meta";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card } from "@/components/ui/Card";
import { HealthTimeline } from "@/components/timeline/HealthTimeline";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { TimelineEventType } from "@/types";

const FILTERS: { id: TimelineEventType | "all"; labelKey: string }[] = [
  { id: "all", labelKey: "medicalHistory.filter.all" },
  { id: "doctor-visit", labelKey: "medicalHistory.filter.doctorVisits" },
  { id: "blood-test", labelKey: "medicalHistory.filter.bloodTests" },
  { id: "ct-scan", labelKey: "medicalHistory.filter.ctScans" },
  { id: "mri", labelKey: "medicalHistory.filter.mri" },
  { id: "vaccination", labelKey: "medicalHistory.filter.vaccinations" },
  { id: "hospitalization", labelKey: "medicalHistory.filter.hospitalizations" },
];

export function MedicalHistoryView() {
  const [filter, setFilter] = useState<TimelineEventType | "all">("all");
  const { t } = useTranslation();

  const filtered = useMemo(
    () => (filter === "all" ? timeline : timeline.filter((e) => e.type === filter)),
    [filter]
  );

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow={t("medicalHistory.eyebrow")}
        title={t("history.title")}
        subtitle={`${timeline.length} ${t("medicalHistory.subtitle")}`}
      />

      <HealthTimeline />

      <Card className="p-0">
        <div className="flex flex-wrap gap-2 border-b border-hairline p-4">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                "rounded-full border px-3 py-1.5 text-[11.5px] transition",
                filter === f.id
                  ? "border-cyan/30 bg-cyan/10 text-cyan"
                  : "border-hairline text-text-secondary hover:border-hairline-strong"
              )}
            >
              {t(f.labelKey)}
            </button>
          ))}
        </div>

        <div className="divide-y divide-hairline">
          {filtered.map((event, i) => {
            const meta = TIMELINE_TYPE_META[event.type];
            const Icon = meta.icon;
            return (
              <motion.div
                key={event.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: i * 0.03 }}
                className="flex items-start gap-4 px-5 py-4"
              >
                <span
                  className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                  style={{ backgroundColor: meta.color + "1a", color: meta.color }}
                >
                  <Icon size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <p className="truncate text-[13.5px] font-medium text-text-primary">
                      {event.title}
                    </p>
                    <span className="shrink-0 tabular-nums text-[11.5px] text-text-tertiary">
                      {formatEventDate(event.date)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] text-text-tertiary">{event.facility}</p>
                  <p className="mt-1.5 text-[12.5px] leading-relaxed text-text-secondary">
                    {event.description}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
