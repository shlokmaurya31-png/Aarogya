"use client";

import { motion } from "framer-motion";
import { CalendarDays, Video, MapPin, Plus } from "lucide-react";
import { appointments } from "@/lib/mock-data";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card } from "@/components/ui/Card";
import { useToastStore } from "@/store/useToastStore";
import { openDirections } from "@/lib/download";
import { useTranslation } from "@/hooks/useTranslation";

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
}

export function PatientAppointmentsView() {
  const upcoming = appointments.filter((a) => a.status === "upcoming");
  const past = appointments.filter((a) => a.status !== "upcoming");
  const push = useToastStore((s) => s.push);
  const { t } = useTranslation();

  function joinOrDirections(mode: "video" | "in-person", facility: string, doctor: string) {
    if (mode === "video") {
      push(`Connecting your video call with ${doctor}…`, "cyan");
    } else {
      openDirections(facility);
    }
  }

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow="Appointments"
        title={t("appointments.titlePatient")}
        subtitle="Everything you have booked, in one place"
        action={
          <button
            onClick={() => push("Booking request sent, you'll get a confirmation shortly", "emerald")}
            className="flex items-center gap-1.5 rounded-full bg-cyan px-4 py-2.5 text-[13px] font-medium text-ink transition hover:brightness-110 active:scale-[0.97]"
          >
            <Plus size={15} /> {t("btn.bookVisit")}
          </button>
        }
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {upcoming.map((a, i) => (
          <motion.div
            key={a.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: i * 0.06 }}
          >
            <Card className="h-full">
              <p className="text-[15px] font-semibold text-text-primary">{a.doctor}</p>
              <p className="text-[13px] text-text-tertiary">{a.specialty}</p>
              <div className="mt-4 flex items-center gap-2 text-[13px] text-text-secondary">
                <CalendarDays size={15} className="text-text-tertiary" />
                {formatDate(a.date)} · {a.time}
              </div>
              <div className="mt-2 flex items-center gap-2 text-[13px] text-text-secondary">
                {a.mode === "video" ? (
                  <Video size={15} className="text-text-tertiary" />
                ) : (
                  <MapPin size={15} className="text-text-tertiary" />
                )}
                {a.facility}
              </div>
              <button
                onClick={() => joinOrDirections(a.mode, a.facility, a.doctor)}
                className="mt-4 w-full rounded-full border border-hairline py-2.5 text-[13px] font-medium text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
              >
                {a.mode === "video" ? t("btn.joinVideo") : t("btn.getDirections")}
              </button>
            </Card>
          </motion.div>
        ))}
        {upcoming.length === 0 && (
          <Card className="md:col-span-2">
            <p className="text-[13px] text-text-secondary">
              Nothing booked yet. Tap &ldquo;Book a visit&rdquo; whenever you&rsquo;re ready.
            </p>
          </Card>
        )}
      </div>

      <div>
        <p className="mb-2.5 text-[12px] font-medium text-text-secondary">Earlier visits</p>
        <Card className="divide-y divide-hairline p-0">
          {past.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-4 px-5 py-3.5">
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-medium text-text-primary">{a.doctor}</p>
                <p className="truncate text-[12px] text-text-tertiary">{a.specialty} · {a.facility}</p>
              </div>
              <span className="shrink-0 text-[12px] text-text-tertiary">{formatDate(a.date)}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
