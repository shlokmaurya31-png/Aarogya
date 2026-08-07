"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Phone, Siren, Ambulance, Loader2, ShieldCheck } from "lucide-react";
import { emergencyContacts, patient } from "@/lib/mock-data";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card, CardLabel } from "@/components/ui/Card";
import { BedBookingCard } from "@/components/dashboard/BedBookingCard";
import { useToastStore } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";
import { useUiStore } from "@/store/useUiStore";
import { usePatientStore, PATIENT_PLACEHOLDER } from "@/store/usePatientStore";

function resolveOrPlaceholder(value: string | undefined, placeholder: string, translated: string) {
  return value && value !== placeholder ? value : translated;
}

export function EmergencyView() {
  const [sosState, setSosState] = useState<"idle" | "sending" | "sent">("idle");
  const push = useToastStore((s) => s.push);
  const { t } = useTranslation();

  const isPatientMode = useUiStore((s) => s.mode === "patient");
  const patientProfile = usePatientStore((s) => s.profile);
  const myEmergencyContacts = usePatientStore((s) => s.emergencyContacts);

  const bloodGroup = isPatientMode
    ? resolveOrPlaceholder(patientProfile?.bloodGroup, PATIENT_PLACEHOLDER.bloodGroupUnknown, t("onboarding.bloodGroup.unknown"))
    : patient.bloodGroup;
  const allergiesText = isPatientMode
    ? patientProfile && !(patientProfile.allergies.length === 1 && patientProfile.allergies[0] === PATIENT_PLACEHOLDER.noneReported)
      ? patientProfile.allergies.join(", ")
      : t("patientProfile.noneReported")
    : patient.allergies.join(", ");
  const age = isPatientMode ? patientProfile?.age ?? t("emergencyView.notSet") : patient.age;
  const abhaNumber = isPatientMode
    ? resolveOrPlaceholder(patientProfile?.abhaNumber, PATIENT_PLACEHOLDER.notLinkedYet, t("emergencyView.notLinked"))
    : patient.abhaNumber;
  const tpa = isPatientMode ? patientProfile?.tpa : patient.tpa;
  const tpaName = resolveOrPlaceholder(tpa?.name, PATIENT_PLACEHOLDER.notAssignedYet, t("emergencyView.notAssignedYet"));
  const tpaHealthCardId = resolveOrPlaceholder(tpa?.healthCardId, PATIENT_PLACEHOLDER.notAssigned, t("emergencyView.notAssigned"));
  const tpaPolicyNumber = resolveOrPlaceholder(tpa?.policyNumber, PATIENT_PLACEHOLDER.notAssigned, t("emergencyView.notAssigned"));
  const hasTpaHelpline = Boolean(tpa && tpa.helpline !== PATIENT_PLACEHOLDER.addInsuranceInSettings);
  const contacts = isPatientMode ? myEmergencyContacts : emergencyContacts;

  function triggerSos() {
    if (sosState !== "idle") return;
    setSosState("sending");
    setTimeout(() => {
      setSosState("sent");
      push(t("emergencyView.toastSosSent"), "red");
      setTimeout(() => setSosState("idle"), 4000);
    }, 900);
  }

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow={t("nav.emergency")}
        title={t("emergency.title")}
        subtitle={t("emergencyView.subtitle")}
      />

      <Card className="flex flex-col items-start justify-between gap-4 border-red/20 bg-red/[0.05] sm:flex-row sm:items-center">
        <div className="flex items-center gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-red/15 text-red">
            <Siren size={20} />
          </span>
          <div>
            <p className="text-[15px] font-semibold text-text-primary">{t("emergencyView.sosTitle")}</p>
            <p className="text-[12px] text-text-secondary">
              {t("emergencyView.sosDescription")}
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

      <BedBookingCard />

      <Card>
        <div className="flex items-center justify-between">
          <CardLabel>{t("label.criticalInfo")}</CardLabel>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl bg-black/[0.035] px-3 py-3 text-center">
            <p className="text-[16px] font-semibold text-red">{bloodGroup}</p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">{t("prescriptionDoc.label.bloodGroup")}</p>
          </div>
          <div className="rounded-2xl bg-black/[0.035] px-3 py-3 text-center">
            <p className="truncate text-[13px] font-semibold text-amber">{allergiesText}</p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">{t("emergencyView.allergiesLabel")}</p>
          </div>
          <div className="rounded-2xl bg-black/[0.035] px-3 py-3 text-center">
            <p className="text-[13px] font-semibold text-text-primary">{age} {t("prescriptionDoc.label.yrs")}</p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">{t("onboarding.field.age")}</p>
          </div>
          <div className="rounded-2xl bg-black/[0.035] px-3 py-3 text-center">
            <p className="truncate text-[13px] font-semibold text-text-primary">{abhaNumber}</p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">{t("emergencyView.abhaIdLabel")}</p>
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
              <p className="text-[15px] font-semibold text-text-primary">{t("emergencyView.tpaTitle")}</p>
              <p className="text-[12px] text-text-secondary">
                {t("emergencyView.tpaDescription")}
              </p>
            </div>
          </div>
          {hasTpaHelpline && tpa && (
            <a
              href={`tel:${tpa.helpline.replace(/\D/g, "")}`}
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink transition hover:brightness-110"
            >
              <Phone size={12} /> {tpa.helpline}
            </a>
          )}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3">
          <div className="rounded-2xl bg-black/[0.035] px-3 py-3 text-center">
            <p className="truncate text-[12.5px] font-semibold text-text-primary">{tpaName}</p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">{t("emergencyView.tpaLabel")}</p>
          </div>
          <div className="rounded-2xl bg-black/[0.035] px-3 py-3 text-center">
            <p className="truncate text-[12.5px] font-semibold text-text-primary">{tpaHealthCardId}</p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">{t("emergencyView.healthCardIdLabel")}</p>
          </div>
          <div className="rounded-2xl bg-black/[0.035] px-3 py-3 text-center">
            <p className="truncate text-[12.5px] font-semibold text-text-primary">{tpaPolicyNumber}</p>
            <p className="mt-0.5 text-[10.5px] text-text-tertiary">{t("emergencyView.policyNumberLabel")}</p>
          </div>
        </div>
      </Card>

      <Card className="p-0">
        <div className="border-b border-hairline p-5">
          <CardLabel>{t("label.contactsPriority")}</CardLabel>
        </div>
        {contacts.length === 0 && (
          <p className="px-5 py-6 text-center text-[12.5px] text-text-tertiary">
            {t("emergencyView.noContacts")}
          </p>
        )}
        <div className="divide-y divide-hairline">
          {contacts.map((c, i) => (
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
