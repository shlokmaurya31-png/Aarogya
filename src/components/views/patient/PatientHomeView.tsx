"use client";

import { motion } from "framer-motion";
import { CalendarDays, Pill, Check, Video, MapPin } from "lucide-react";
import { patient, appointments, upcomingMedicines } from "@/lib/mock-data";
import { Card, CardLabel } from "@/components/ui/Card";
import { HealthScoreCard } from "@/components/dashboard/HealthScoreCard";
import { SystemsCard } from "@/components/dashboard/SystemsCard";
import { AiAssistantPanel } from "@/components/ai/AiAssistantPanel";
import { NotificationsList } from "@/components/dashboard/NotificationsList";
import { cn } from "@/lib/utils";
import { useToastStore } from "@/store/useToastStore";
import { openDirections } from "@/lib/download";
import { useTranslation } from "@/hooks/useTranslation";

function greetingKey() {
  const h = new Date().getHours();
  if (h < 12) return "patientHome.morning";
  if (h < 17) return "patientHome.afternoon";
  return "patientHome.evening";
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "short" });
}

export function PatientHomeView() {
  const nextAppointment = appointments.find((a) => a.status === "upcoming");
  const dueToday = upcomingMedicines.filter((m) => !m.taken);
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
      <motion.header
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
      >
        <p className="text-[11px] uppercase tracking-[0.14em] text-text-tertiary">{t(greetingKey())}</p>
        <h1 className="mt-1 text-[24px] font-semibold tracking-tight text-text-primary">
          {patient.name.split(" ")[0]}, {t("patientHome.subheading")}
        </h1>
      </motion.header>

      {/* hero: Ask Aarogya is the main event on this page */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.05 }}
      >
        <AiAssistantPanel />
      </motion.div>

      {/* secondary row: score, systems */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
        >
          <HealthScoreCard />
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          <SystemsCard />
        </motion.div>
      </div>

      {/* bento row: medicines, appointment, notifications */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2 }}
        >
          <Card className="h-full">
            <CardLabel>{t("patientHome.medicinesTitle")}</CardLabel>
            <div className="mt-3 flex flex-col gap-2">
              {upcomingMedicines.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-3 rounded-2xl bg-black/[0.035] px-3.5 py-3"
                >
                  <span
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
                      m.taken ? "bg-emerald/15 text-emerald" : "bg-black/[0.06] text-text-secondary"
                    )}
                  >
                    {m.taken ? <Check size={15} /> : <Pill size={15} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-medium text-text-primary">{m.name}</p>
                    <p className="text-[12px] text-text-tertiary">
                      {m.dose} · {m.time}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            {dueToday.length > 0 && (
              <p className="mt-3 text-[12px] text-text-tertiary">
                {dueToday.length} {dueToday.length === 1 ? "dose" : "doses"} left for today
              </p>
            )}
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.25 }}
        >
          <Card className="h-full">
            <CardLabel>{t("patientHome.nextAppointment")}</CardLabel>
            {nextAppointment ? (
              <div className="mt-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-cyan/10 text-cyan">
                    <CalendarDays size={17} />
                  </span>
                  <div>
                    <p className="text-[14px] font-semibold text-text-primary">
                      {nextAppointment.doctor}
                    </p>
                    <p className="text-[12px] text-text-tertiary">{nextAppointment.specialty}</p>
                  </div>
                </div>
                <p className="mt-3 text-[13px] text-text-secondary">
                  {formatDate(nextAppointment.date)} at {nextAppointment.time}
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-text-tertiary">
                  {nextAppointment.mode === "video" ? <Video size={12} /> : <MapPin size={12} />}
                  {nextAppointment.facility}
                </p>
                <button
                  onClick={() =>
                    joinOrDirections(nextAppointment.mode, nextAppointment.facility, nextAppointment.doctor)
                  }
                  className="mt-4 w-full rounded-full border border-hairline py-2.5 text-[13px] font-medium text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
                >
                  {nextAppointment.mode === "video" ? t("btn.joinVideo") : t("btn.getDirections")}
                </button>
              </div>
            ) : (
              <p className="mt-3 text-[13px] text-text-secondary">Nothing booked right now.</p>
            )}
          </Card>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.3 }}
        >
          <NotificationsList />
        </motion.div>
      </div>
    </div>
  );
}
