"use client";

import { motion } from "framer-motion";
import { CalendarDays, Video, MapPin, Plus } from "lucide-react";
import { appointments } from "@/lib/mock-data";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useToastStore } from "@/store/useToastStore";
import { openDirections } from "@/lib/download";
import type { AppointmentStatus } from "@/types";

const STATUS_TONE: Record<AppointmentStatus, "emerald" | "neutral" | "red"> = {
  upcoming: "emerald",
  completed: "neutral",
  cancelled: "red",
};

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function AppointmentsView() {
  const upcoming = appointments.filter((a) => a.status === "upcoming");
  const past = appointments.filter((a) => a.status !== "upcoming");
  const push = useToastStore((s) => s.push);

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow="Appointments"
        title="Your consultations"
        subtitle={`${upcoming.length} upcoming · Next with ${upcoming[0]?.doctor ?? "—"}`}
        action={
          <button
            onClick={() => push("Appointment request sent — the patient will be notified to confirm a slot", "emerald")}
            className="flex items-center gap-1.5 rounded-full bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.97]"
          >
            <Plus size={14} /> Book appointment
          </button>
        }
      />

      <div>
        <p className="mb-2.5 text-[12px] font-medium text-text-secondary">Upcoming</p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {upcoming.map((a, i) => (
            <motion.div
              key={a.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: i * 0.06 }}
            >
              <Card className="h-full">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-[14px] font-semibold">{a.doctor}</p>
                    <p className="text-[12px] text-text-tertiary">{a.specialty}</p>
                  </div>
                  <StatusPill label={a.mode === "video" ? "Video" : "In person"} tone="cyan" />
                </div>
                <div className="mt-4 flex items-center gap-2 text-[12.5px] text-text-secondary">
                  <CalendarDays size={14} className="text-text-tertiary" />
                  {formatDate(a.date)} · {a.time}
                </div>
                <div className="mt-2 flex items-center gap-2 text-[12.5px] text-text-secondary">
                  {a.mode === "video" ? (
                    <Video size={14} className="text-text-tertiary" />
                  ) : (
                    <MapPin size={14} className="text-text-tertiary" />
                  )}
                  {a.facility}
                </div>
              </Card>
            </motion.div>
          ))}
        </div>
      </div>

      <div>
        <p className="mb-2.5 text-[12px] font-medium text-text-secondary">Past</p>
        <Card className="divide-y divide-hairline p-0">
          {past.map((a) => (
            <div key={a.id} className="flex items-center justify-between gap-4 px-5 py-3.5">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-text-primary">{a.doctor}</p>
                <p className="truncate text-[12px] text-text-tertiary">
                  {a.specialty} · {a.facility}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="tabular-nums text-[12px] text-text-tertiary">
                  {formatDate(a.date)}
                </span>
                <StatusPill label={a.status} tone={STATUS_TONE[a.status]} />
              </div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
