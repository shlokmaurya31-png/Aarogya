"use client";

import { motion } from "framer-motion";
import { BedDouble, Clock, MapPinned, Navigation, X } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { useBedBookingStore } from "@/store/useBedBookingStore";
import { useToastStore } from "@/store/useToastStore";
import { useUiStore } from "@/store/useUiStore";
import { usePatientStore } from "@/store/usePatientStore";
import { openDirections } from "@/lib/download";
import { patient } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/hooks/useTranslation";
import type { BedCategory } from "@/types";

const CATEGORY_KEY: Record<BedCategory, string> = {
  emergency: "hospital.ward.emergency",
  icu: "hospital.ward.icu",
  general: "hospital.ward.general",
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

export function BedBookingCard() {
  const { t } = useTranslation();
  const hospitals = useBedBookingStore((s) => s.hospitals);
  const activeBooking = useBedBookingStore((s) => s.activeBooking);
  const bookBed = useBedBookingStore((s) => s.bookBed);
  const cancelBooking = useBedBookingStore((s) => s.cancelBooking);
  const push = useToastStore((s) => s.push);
  const isPatientMode = useUiStore((s) => s.mode === "patient");
  const patientProfile = usePatientStore((s) => s.profile);
  const bookingName = isPatientMode ? patientProfile?.name ?? t("bedBooking.you") : patient.name;

  function handleBook(hospitalId: string, category: BedCategory) {
    const result = bookBed(hospitalId, category, bookingName);
    if (!result.ok) {
      push(result.error, "amber");
      return;
    }
    push(
      `${t("bedBooking.bedReservedAt")} ${result.booking.hospitalName}${t("bedBooking.showCodeAtDesk")}`,
      "emerald"
    );
  }

  if (activeBooking) {
    const hospital = hospitals.find((h) => h.id === activeBooking.hospitalId);
    return (
      <Card className="border-emerald/25 bg-emerald/[0.05]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald/15 text-emerald">
              <BedDouble size={20} />
            </span>
            <div>
              <p className="text-[15px] font-semibold text-text-primary">{t("bedBooking.reserved")}</p>
              <p className="mt-0.5 text-[12px] text-text-secondary">
                {t(CATEGORY_KEY[activeBooking.category])} {t("bedBooking.bedAt")} {activeBooking.hospitalName}
                {t("bedBooking.bookedAt")}{" "}
                {formatTime(activeBooking.bookedAt)}
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              cancelBooking();
              push(t("bedBooking.bookingCancelled"), "amber");
            }}
            aria-label={t("bedBooking.cancelBooking")}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-tertiary transition hover:bg-black/[0.05] hover:text-red"
          >
            <X size={15} />
          </button>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-black/[0.035] px-4 py-3.5">
          <div>
            <p className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">{t("bedBooking.confirmationCode")}</p>
            <p className="mt-0.5 font-mono text-[18px] font-semibold tracking-wide text-emerald">
              {activeBooking.confirmationCode}
            </p>
          </div>
          <button
            onClick={() => openDirections(activeBooking.hospitalName)}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-hairline px-3.5 py-2 text-[12px] font-medium text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
          >
            <Navigation size={13} /> {t("bedBooking.directions")}
          </button>
        </div>
        <p className="mt-2.5 text-[11.5px] text-text-tertiary">
          {t("bedBooking.admissionDeskPrefix")} {hospital?.name ?? activeBooking.hospitalName}{" "}
          {t("bedBooking.admissionDeskSuffix")}
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-4">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-cyan/10 text-cyan">
          <BedDouble size={20} />
        </span>
        <div>
          <p className="text-[15px] font-semibold text-text-primary">{t("bedBooking.title")}</p>
          <p className="text-[12px] text-text-secondary">
            {t("bedBooking.subtitle")}
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-2.5">
        {hospitals.map((h, i) => {
          const categories: BedCategory[] = ["emergency", "icu", "general"];
          const totalBeds = h.emergencyBeds + h.icuBeds + h.generalBeds;
          return (
            <motion.div
              key={h.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.04 }}
              className="rounded-2xl border border-hairline px-4 py-3.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium text-text-primary">{h.name}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11.5px] text-text-tertiary">
                    <span className="flex items-center gap-1">
                      <MapPinned size={11} /> {h.city} · {h.distanceKm} {t("bedBooking.kmUnit")}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock size={11} /> ~{h.avgWaitMinutes} {t("bedBooking.minErWaitWithoutBooking")}
                    </span>
                  </div>
                </div>
                {totalBeds === 0 && <CardLabel className="shrink-0 text-red">{t("bedBooking.noBedsFree")}</CardLabel>}
              </div>

              <div className="mt-2.5 flex flex-wrap gap-2">
                {categories.map((cat) => {
                  const count =
                    cat === "emergency" ? h.emergencyBeds : cat === "icu" ? h.icuBeds : h.generalBeds;
                  const disabled = count <= 0;
                  return (
                    <button
                      key={cat}
                      onClick={() => handleBook(h.id, cat)}
                      disabled={disabled}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-[11.5px] font-medium transition",
                        disabled
                          ? "cursor-not-allowed border-hairline text-text-tertiary opacity-50"
                          : "border-cyan/30 text-cyan hover:bg-cyan/10 active:scale-[0.97]"
                      )}
                    >
                      {t(CATEGORY_KEY[cat])} · {count}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          );
        })}
      </div>
    </Card>
  );
}
