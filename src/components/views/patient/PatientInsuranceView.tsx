"use client";

import { motion } from "framer-motion";
import { CreditCard, Phone, ShieldCheck, FileCheck, IdCard, Headset, Download, Building2 } from "lucide-react";
import { majorIndianTpas } from "@/lib/mock-data";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { downloadTextFile } from "@/lib/download";
import { usePatientStore, PATIENT_PLACEHOLDER } from "@/store/usePatientStore";
import { useTranslation } from "@/hooks/useTranslation";
import type { ClaimStatus } from "@/types";

const STATUS_TONE: Record<ClaimStatus, "emerald" | "amber" | "cyan" | "red"> = {
  approved: "emerald",
  processing: "amber",
  submitted: "cyan",
  rejected: "red",
};

const TPA_FUNCTIONS = [
  {
    icon: CreditCard,
    titleKey: "patientInsurance.function.cashlessClaims.title",
    detailKey: "patientInsurance.function.cashlessClaims.detail",
  },
  {
    icon: FileCheck,
    titleKey: "patientInsurance.function.claimProcessing.title",
    detailKey: "patientInsurance.function.claimProcessing.detail",
  },
  {
    icon: IdCard,
    titleKey: "patientInsurance.function.idCard.title",
    detailKey: "patientInsurance.function.idCard.detail",
  },
  {
    icon: Headset,
    titleKey: "patientInsurance.function.customerSupport.title",
    detailKey: "patientInsurance.function.customerSupport.detail",
  },
];

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function formatCurrency(n: number) {
  return `₹${n.toLocaleString("en-IN")}`;
}

export function PatientInsuranceView() {
  const { t } = useTranslation();
  const profile = usePatientStore((s) => s.profile);
  const insuranceClaims = usePatientStore((s) => s.insuranceClaims);
  const totalClaimed = insuranceClaims.reduce((sum, c) => sum + c.amount, 0);
  const hasInsurance = Boolean(profile && profile.insurance !== PATIENT_PLACEHOLDER.notAddedYet);
  const tpa = profile?.tpa;

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow={t("nav.insurance")}
        title={t("nav.insurance")}
        subtitle={t("patientInsurance.subtitle")}
      />

      <Card className="relative overflow-hidden bg-gradient-to-br from-cyan/[0.08] to-transparent">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-cyan/15 text-cyan">
              <ShieldCheck size={20} />
            </span>
            <div>
              <p className="text-[15px] font-semibold text-text-primary">{hasInsurance ? tpa?.name : t("patientInsurance.tpaNotAssigned")}</p>
              <p className="text-[12px] text-text-tertiary">{hasInsurance ? profile?.insurance : t("patientInsurance.notAddedYet")}</p>
            </div>
          </div>
          <StatusPill
            label={hasInsurance ? t("patientInsurance.active") : t("patientInsurance.notSetUp")}
            tone={hasInsurance ? "emerald" : "amber"}
          />
        </div>

        {hasInsurance ? (
          <>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-2xl bg-black/[0.035] px-3 py-3">
                <p className="truncate text-[13px] font-semibold text-text-primary">{profile?.name}</p>
                <p className="mt-0.5 text-[10.5px] text-text-tertiary">{t("patientInsurance.cardholder")}</p>
              </div>
              <div className="rounded-2xl bg-black/[0.035] px-3 py-3">
                <p className="truncate text-[13px] font-semibold text-text-primary">{tpa?.healthCardId}</p>
                <p className="mt-0.5 text-[10.5px] text-text-tertiary">{t("patientInsurance.healthCardId")}</p>
              </div>
              <div className="rounded-2xl bg-black/[0.035] px-3 py-3">
                <p className="truncate text-[13px] font-semibold text-text-primary">{tpa?.policyNumber}</p>
                <p className="mt-0.5 text-[10.5px] text-text-tertiary">{t("patientInsurance.policyNumber")}</p>
              </div>
              <a
                href={`tel:${tpa?.helpline.replace(/\D/g, "") ?? ""}`}
                className="flex flex-col justify-center rounded-2xl bg-cyan/10 px-3 py-3 transition hover:bg-cyan/15"
              >
                <p className="flex items-center gap-1.5 truncate text-[13px] font-semibold text-cyan">
                  <Phone size={12} /> {tpa?.helpline}
                </p>
                <p className="mt-0.5 text-[10.5px] text-text-tertiary">{t("patientInsurance.tpaHelpline")}</p>
              </a>
            </div>

            <button
              onClick={() =>
                downloadTextFile(
                  "tpa-health-card.txt",
                  `${tpa?.name}\n${t("patientInsurance.cardholder")}: ${profile?.name}\n${t("patientInsurance.healthCardId")}: ${tpa?.healthCardId}\n${t("patientInsurance.policyNumber")}: ${tpa?.policyNumber}\n${t("patientInsurance.insurer")}: ${profile?.insurance}\n${t("patientInsurance.tpaHelpline")}: ${tpa?.helpline}\n\n${t("patientInsurance.cardInstructions")}`
                )
              }
              className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-full border border-hairline py-2.5 text-[13px] font-medium text-text-secondary transition hover:border-cyan/30 hover:text-cyan sm:w-auto sm:px-6"
            >
              <Download size={14} /> {t("patientInsurance.downloadHealthCard")}
            </button>
          </>
        ) : (
          <p className="mt-4 text-[13px] text-text-secondary">{t("patientInsurance.emptyInsurance")}</p>
        )}
      </Card>

      <Card>
        <CardLabel>{t("patientInsurance.whatIsTpa")}</CardLabel>
        <p className="mt-2.5 text-[13px] leading-relaxed text-text-secondary">{t("patientInsurance.tpaDescription")}</p>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {TPA_FUNCTIONS.map((f, i) => (
            <motion.div
              key={f.titleKey}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.05 }}
              className="flex items-start gap-3 rounded-2xl bg-black/[0.03] px-4 py-3.5"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-cyan/10 text-cyan">
                <f.icon size={14} />
              </span>
              <div>
                <p className="text-[13px] font-medium text-text-primary">{t(f.titleKey)}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-text-tertiary">{t(f.detailKey)}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </Card>

      <Card className="p-0">
        <div className="border-b border-hairline p-5">
          <CardLabel>{t("label.claimsHistory")}</CardLabel>
        </div>
        {insuranceClaims.length === 0 && (
          <p className="px-5 py-6 text-center text-[13px] text-text-tertiary">{t("patientInsurance.noClaimsFiled")}</p>
        )}
        <div className="divide-y divide-hairline">
          {insuranceClaims.map((c, i) => (
            <motion.div
              key={c.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.05 }}
              className="flex items-center justify-between gap-4 px-5 py-4"
            >
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-text-primary">{c.reason}</p>
                <p className="truncate text-[11.5px] tabular-nums text-text-tertiary">
                  {c.claimNo} · {formatDate(c.date)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="tabular-nums text-[13px] font-medium text-text-primary">
                  {formatCurrency(c.amount)}
                </span>
                <StatusPill label={t(`patientInsurance.status.${c.status}`)} tone={STATUS_TONE[c.status]} />
              </div>
            </motion.div>
          ))}
        </div>
        {insuranceClaims.length > 0 && (
          <p className="border-t border-hairline px-5 py-3 text-[11.5px] text-text-tertiary">
            {formatCurrency(totalClaimed)} {t("patientInsurance.claimedAcross")} {insuranceClaims.length}{" "}
            {t("patientInsurance.claimsLabel")}
          </p>
        )}
      </Card>

      <Card>
        <CardLabel>{t("patientInsurance.majorIndianTpas")}</CardLabel>
        <div className="mt-3 divide-y divide-hairline">
          {majorIndianTpas.map((tpa, i) => (
            <motion.div
              key={tpa.name}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.05 }}
              className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/[0.045] text-text-secondary">
                <Building2 size={14} />
              </span>
              <div>
                <p className="text-[13px] font-medium text-text-primary">{tpa.name}</p>
                <p className="mt-0.5 text-[12px] leading-relaxed text-text-tertiary">{tpa.description}</p>
              </div>
            </motion.div>
          ))}
        </div>
      </Card>
    </div>
  );
}
