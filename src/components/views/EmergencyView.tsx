"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Phone, Siren, Ambulance, Loader2, ShieldCheck } from "lucide-react";
import { emergencyContacts, patient } from "@/lib/mock-data";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card, CardLabel } from "@/components/ui/Card";
import { useToastStore } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";

export function EmergencyView() {
  const [sosState, setSosState] = useState<"idle" | "sending" | "sent">("idle");
  const push = useToastStore((s) => s.push);
  const { t } = useTranslation();

  function triggerSos() {
    if (sosState !== "idle") return;
    setSosState("sending");
    setTimeout(() => {
      setSosState("sent");
      push("SOS sent — contacts alerted and nearest ambulance notified", "red");
      setTimeout(() => setSosState("idle"), 4000);
    }, 900);
  }

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow="Emergency"
        title={t("emergency.title")}
        subtitle="Blood group, allergies and contacts are shared instantly with responders on SOS"
      />

      <Card className="flex flex-col items-start justify-between gap-4 border-red/20 bg-red/[0.05] sm:flex-row sm:items-center">
        <div className="flex items-center gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-red/15 text-red">
            <Siren size={20} />
          </span>
          <div>
            <p className="text-[15px] font-semibold text-text-primary">Emergency SOS</p>
            <p className="text-[12px] text-text-secondary">
              Alerts your contacts and shares live location with the nearest ambulance
            </p>
          </div>
        </div>
        <button
          onClick={triggerSos}
          disabled={sosState !== "idle"}
          className="flex w-full shrink-0 items-center justify-center gap-1.5 rounded-full bg-red px-6 py-2.5 text-[13px] font-semibold text-ink transition hover:brightness-110 active:scale-[0.97] disabled:opacity-70 sm:w-auto"
        >
          {sosState === "sending" && <Loader2 size={14} className="animate-spin" />}
          {sosState === "idle" && t("btn.triggerSos")}
          {sosState === "sending" && t("btn.sosSending")}
          {sosState === "sent" && t("btn.sosSent")}
        </button>
      </Card>

      <Card>
        <div className="flex items-center justify-between">
          <CardLabel>{t("label.criticalInfo")}</CardLabel>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl bg-black/[0.035] px-3 py-3 text-center">
            <p className="text-[16px] font-semibold text-red">{patient.bloodGroup}</p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">Blood Group</p>
          </div>
          <div className="rounded-2xl bg-black/[0.035] px-3 py-3 text-center">
            <p className="truncate text-[13px] font-semibold text-amber">
              {patient.allergies.join(", ")}
            </p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">Allergies</p>
          </div>
          <div className="rounded-2xl bg-black/[0.035] px-3 py-3 text-center">
            <p className="text-[13px] font-semibold text-text-primary">{patient.age} yrs</p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">Age</p>
          </div>
          <div className="rounded-2xl bg-black/[0.035] px-3 py-3 text-center">
            <p className="truncate text-[13px] font-semibold text-text-primary">{patient.abhaNumber}</p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">ABHA ID</p>
          </div>
        </div>
      </Card>

      <Card className="border-cyan/20 bg-cyan/[0.05]">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-cyan/15 text-cyan">
              <ShieldCheck size={20} />
            </span>
            <div>
              <p className="text-[15px] font-semibold text-text-primary">Cashless Treatment (TPA)</p>
              <p className="text-[12px] text-text-secondary">
                Show this at any network hospital desk to admit without paying upfront
              </p>
            </div>
          </div>
          <a
            href={`tel:${patient.tpa.helpline.replace(/\D/g, "")}`}
            className="flex shrink-0 items-center gap-1.5 rounded-full bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink transition hover:brightness-110"
          >
            <Phone size={12} /> {patient.tpa.helpline}
          </a>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <div className="rounded-2xl bg-black/[0.035] px-3 py-3 text-center">
            <p className="truncate text-[12.5px] font-semibold text-text-primary">{patient.tpa.name}</p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">TPA</p>
          </div>
          <div className="rounded-2xl bg-black/[0.035] px-3 py-3 text-center">
            <p className="truncate text-[12.5px] font-semibold text-text-primary">{patient.tpa.healthCardId}</p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">Health Card ID</p>
          </div>
          <div className="rounded-2xl bg-black/[0.035] px-3 py-3 text-center">
            <p className="truncate text-[12.5px] font-semibold text-text-primary">{patient.tpa.policyNumber}</p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">Policy Number</p>
          </div>
        </div>
      </Card>

      <Card className="p-0">
        <div className="border-b border-hairline p-5">
          <CardLabel>{t("label.contactsPriority")}</CardLabel>
        </div>
        <div className="divide-y divide-hairline">
          {emergencyContacts.map((c, i) => (
            <motion.div
              key={c.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.05 }}
              className="flex items-center justify-between gap-4 px-5 py-4"
            >
              <div className="flex items-center gap-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/[0.045] text-[12px] font-medium text-text-secondary">
                  {c.priority === 4 ? <Ambulance size={15} /> : c.name.charAt(0)}
                </span>
                <div>
                  <p className="text-[13px] font-medium text-text-primary">{c.name}</p>
                  <p className="text-[11.5px] text-text-tertiary">{c.relation}</p>
                </div>
              </div>
              <a
                href={`tel:${c.phone.replace(/\s/g, "")}`}
                className="flex items-center gap-1.5 rounded-full border border-hairline px-3.5 py-1.5 text-[12px] text-text-secondary transition hover:border-cyan/30 hover:text-cyan"
              >
                <Phone size={12} />
                {c.phone}
              </a>
            </motion.div>
          ))}
        </div>
      </Card>
    </div>
  );
}
