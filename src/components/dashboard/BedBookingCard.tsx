"use client";

import { motion } from "framer-motion";
import { BedDouble, Clock, MapPinned, Navigation, X } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { useBedBookingStore } from "@/store/useBedBookingStore";
import { useToastStore } from "@/store/useToastStore";
import { openDirections } from "@/lib/download";
import { patient } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import type { BedCategory } from "@/types";

const CATEGORY_LABEL: Record<BedCategory, string> = {
  emergency: "Emergency",
  icu: "ICU",
  general: "General",
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

export function BedBookingCard() {
  const hospitals = useBedBookingStore((s) => s.hospitals);
  const activeBooking = useBedBookingStore((s) => s.activeBooking);
  const bookBed = useBedBookingStore((s) => s.bookBed);
  const cancelBooking = useBedBookingStore((s) => s.cancelBooking);
  const push = useToastStore((s) => s.push);

  function handleBook(hospitalId: string, category: BedCategory) {
    const result = bookBed(hospitalId, category, patient.name);
    if (!result.ok) {
      push(result.error, "amber");
      return;
    }
    push(`Bed reserved at ${result.booking.hospitalName}, show your code at the desk`, "emerald");
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
              <p className="text-[15px] font-semibold text-text-primary">Bed reserved, no ER wait</p>
              <p className="mt-0.5 text-[12px] text-text-secondary">
                {CATEGORY_LABEL[activeBooking.category]} bed at {activeBooking.hospitalName}, booked{" "}
                {formatTime(activeBooking.bookedAt)}
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              cancelBooking();
              push("Booking cancelled", "amber");
            }}
            aria-label="Cancel booking"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-tertiary transition hover:bg-black/[0.05] hover:text-red"
          >
            <X size={15} />
          </button>
        </div>

        <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-black/[0.035] px-4 py-3.5">
          <div>
            <p className="text-[11px] uppercase tracking-[0.1em] text-text-tertiary">Confirmation code</p>
            <p className="mt-0.5 font-mono text-[18px] font-semibold tracking-wide text-emerald">
              {activeBooking.confirmationCode}
            </p>
          </div>
          <button
            onClick={() => openDirections(activeBooking.hospitalName)}
            className="flex shrink-0 items-center gap-1.5 rounded-full border border-hairline px-3.5 py-2 text-[12px] font-medium text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
          >
            <Navigation size={13} /> Directions
          </button>
        </div>
        <p className="mt-2.5 text-[11.5px] text-text-tertiary">
          Show this code at the {hospital?.name ?? activeBooking.hospitalName} admission desk for instant access, no
          queueing at the ER.
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
          <p className="text-[15px] font-semibold text-text-primary">Instant Bed Booking</p>
          <p className="text-[12px] text-text-secondary">
            Reserve a bed now, skip the ER queue and walk straight in
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
                      <MapPinned size={11} /> {h.city} · {h.distanceKm} km
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock size={11} /> ~{h.avgWaitMinutes} min ER wait without booking
                    </span>
                  </div>
                </div>
                {totalBeds === 0 && <CardLabel className="shrink-0 text-red">No beds free</CardLabel>}
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
                      {CATEGORY_LABEL[cat]} · {count}
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
