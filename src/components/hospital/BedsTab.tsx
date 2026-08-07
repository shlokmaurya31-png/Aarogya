"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BedDouble, ChevronDown, Minus, Plus, UserPlus } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useBedBookingStore, capacityFor } from "@/store/useBedBookingStore";
import { useToastStore } from "@/store/useToastStore";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { AdmissionStatus, BedBooking, BedCategory, HospitalAdmission, HospitalBedAvailability } from "@/types";

const STATUS_TONE: Record<AdmissionStatus, "emerald" | "red" | "neutral"> = {
  admitted: "emerald",
  critical: "red",
  discharged: "neutral",
};

function countFor(hospital: HospitalBedAvailability, category: BedCategory) {
  return category === "emergency" ? hospital.emergencyBeds : category === "icu" ? hospital.icuBeds : hospital.generalBeds;
}

export function BedsTab({
  hospital,
  admissions,
  activeBooking,
  onQuickAdmit,
}: {
  hospital: HospitalBedAvailability;
  admissions: HospitalAdmission[];
  activeBooking: BedBooking | null;
  onQuickAdmit: (ward: BedCategory) => void;
}) {
  const { t } = useTranslation();
  const setBedCount = useBedBookingStore((s) => s.setBedCount);
  const push = useToastStore((s) => s.push);
  const categories: BedCategory[] = ["emergency", "icu", "general"];
  const [expanded, setExpanded] = useState<BedCategory | null>(null);

  const CATEGORY_LABEL: Record<BedCategory, string> = {
    emergency: t("hospital.ward.emergency"),
    icu: t("hospital.ward.icu"),
    general: t("hospital.ward.general"),
  };

  function adjust(category: BedCategory, delta: number) {
    const next = countFor(hospital, category) + delta;
    setBedCount(hospital.id, category, next);
    push(
      `${CATEGORY_LABEL[category]} ${t("hospital.beds.bedsUpdatedTo")} ${Math.min(Math.max(0, next), capacityFor(hospital, category))}`,
      "cyan"
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardLabel>{t("hospital.beds.cardTitle")}</CardLabel>
        <div className="mt-4 space-y-3">
          {categories.map((cat, i) => {
            const free = countFor(hospital, cat);
            const capacity = capacityFor(hospital, cat);
            const occupied = capacity - free;
            const pct = capacity > 0 ? Math.round((occupied / capacity) * 100) : 0;
            const occupants = admissions.filter((a) => a.ward === cat && a.status !== "discharged");
            const isExpanded = expanded === cat;
            return (
              <motion.div
                key={cat}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: i * 0.05 }}
                className="rounded-2xl border border-hairline px-4 py-3.5"
              >
                <div className="flex items-center justify-between gap-4">
                  <button
                    onClick={() => setExpanded(isExpanded ? null : cat)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-cyan/10 text-cyan">
                      <BedDouble size={17} />
                    </span>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-[13.5px] font-medium text-text-primary">
                        {CATEGORY_LABEL[cat]}
                        <ChevronDown
                          size={13}
                          className={cn("text-text-tertiary transition-transform", isExpanded && "rotate-180")}
                        />
                      </p>
                      <p className="text-[11.5px] text-text-tertiary">
                        {occupied} {t("hospital.beds.occupiedOf")} {capacity} {t("hospital.beds.total")}
                      </p>
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center gap-2.5">
                    <button
                      onClick={() => onQuickAdmit(cat)}
                      disabled={free <= 0}
                      aria-label={`${t("hospital.beds.admitPatientTo")} ${CATEGORY_LABEL[cat]}`}
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-full border border-hairline text-text-secondary transition",
                        free <= 0 ? "cursor-not-allowed opacity-40" : "hover:border-cyan/30 hover:text-cyan"
                      )}
                    >
                      <UserPlus size={14} />
                    </button>
                    <button
                      onClick={() => adjust(cat, -1)}
                      disabled={free <= 0}
                      aria-label={`${t("hospital.beds.decrease")} ${CATEGORY_LABEL[cat]} ${t("hospital.beds.bedsSuffix")}`}
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-full border border-hairline text-text-secondary transition",
                        free <= 0 ? "cursor-not-allowed opacity-40" : "hover:border-hairline-strong hover:text-text-primary"
                      )}
                    >
                      <Minus size={14} />
                    </button>
                    <p className="w-6 text-center text-[15px] font-semibold tabular-nums">{free}</p>
                    <button
                      onClick={() => adjust(cat, 1)}
                      disabled={free >= capacity}
                      aria-label={`${t("hospital.beds.increase")} ${CATEGORY_LABEL[cat]} ${t("hospital.beds.bedsSuffix")}`}
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-full border border-hairline text-text-secondary transition",
                        free >= capacity ? "cursor-not-allowed opacity-40" : "hover:border-cyan/30 hover:text-cyan"
                      )}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
                <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.07]">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                    className={cn("h-full rounded-full", pct >= 90 ? "bg-red" : pct >= 60 ? "bg-amber" : "bg-emerald")}
                  />
                </div>

                <AnimatePresence>
                  {isExpanded && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="mt-3 space-y-1.5 border-t border-hairline pt-3">
                        {occupants.length === 0 && (
                          <p className="text-[11.5px] text-text-tertiary">{t("hospital.beds.noPatientsInWard")}</p>
                        )}
                        {occupants.map((a) => (
                          <div key={a.id} className="flex items-center justify-between gap-2 text-[11.5px]">
                            <span className="text-text-secondary">
                              {t("hospital.beds.bedPrefix")} {a.bedLabel} · {a.patientName}
                            </span>
                            <StatusPill label={a.status} tone={STATUS_TONE[a.status]} />
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
        <p className="mt-4 text-[11px] text-text-tertiary">{t("hospital.beds.footerHint")}</p>
      </Card>

      {activeBooking && activeBooking.hospitalId === hospital.id && (
        <Card className="border-emerald/25 bg-emerald/[0.05]">
          <CardLabel>{t("hospital.beds.activeReservationTitle")}</CardLabel>
          <p className="mt-2 text-[13px] font-medium text-text-primary">
            {CATEGORY_LABEL[activeBooking.category]} {t("hospital.beds.bedHeldFor")} {activeBooking.patientName}
          </p>
          <p className="mt-1 text-[11.5px] text-text-tertiary">
            {t("hospital.beds.confirmationCode")} <span className="font-mono">{activeBooking.confirmationCode}</span>
          </p>
        </Card>
      )}
    </div>
  );
}
