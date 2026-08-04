"use client";

import { motion } from "framer-motion";
import { FlaskConical, Pill, CalendarClock, MessageCircle } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { RISK_COLOR } from "@/lib/risk";
import { useRecordsStore } from "@/store/useRecordsStore";
import { usePatientStore } from "@/store/usePatientStore";
import { useUiStore } from "@/store/useUiStore";
import { useTranslation } from "@/hooks/useTranslation";
import type { NotificationItem } from "@/types";

const ICONS: Record<NotificationItem["kind"], typeof FlaskConical> = {
  lab: FlaskConical,
  medicine: Pill,
  appointment: CalendarClock,
  message: MessageCircle,
};

export function NotificationsList() {
  const isPatient = useUiStore((s) => s.mode === "patient");
  const doctorNotifications = useRecordsStore((s) => s.notifications);
  const patientNotifications = usePatientStore((s) => s.notifications);
  const notifications = isPatient ? patientNotifications : doctorNotifications;
  const { t } = useTranslation();

  return (
    <Card>
      <CardLabel>{t("label.notifications")}</CardLabel>
      {notifications.length === 0 && (
        <p className="mt-3 py-4 text-center text-[12.5px] text-text-tertiary">Nothing new yet.</p>
      )}
      <div className="mt-3 flex flex-col gap-1">
        {notifications.map((n, i) => {
          const Icon = ICONS[n.kind];
          return (
            <motion.div
              key={n.id}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.4, delay: 0.1 + i * 0.05 }}
              className="flex items-start gap-3 rounded-2xl px-2.5 py-2.5 transition hover:bg-black/[0.035]"
            >
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                style={{
                  backgroundColor: (n.risk ? RISK_COLOR[n.risk] : "#0e7490") + "1a",
                  color: n.risk ? RISK_COLOR[n.risk] : "#0e7490",
                }}
              >
                <Icon size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[12.5px] font-medium text-text-primary">{n.title}</p>
                <p className="truncate text-[11.5px] text-text-tertiary">{n.detail}</p>
              </div>
              <span className="shrink-0 text-[10.5px] text-text-tertiary">{n.time}</span>
            </motion.div>
          );
        })}
      </div>
    </Card>
  );
}
