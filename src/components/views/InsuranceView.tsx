"use client";

import { motion } from "framer-motion";
import { ShieldCheck } from "lucide-react";
import { insuranceClaims, patient } from "@/lib/mock-data";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card, CardLabel } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import { useTranslation } from "@/hooks/useTranslation";
import type { ClaimStatus } from "@/types";

const STATUS_TONE: Record<ClaimStatus, "emerald" | "amber" | "cyan" | "red"> = {
  approved: "emerald",
  processing: "amber",
  submitted: "cyan",
  rejected: "red",
};

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function formatCurrency(n: number) {
  return `₹${n.toLocaleString("en-IN")}`;
}

export function InsuranceView() {
  const totalClaimed = insuranceClaims.reduce((sum, c) => sum + c.amount, 0);
  const { t } = useTranslation();

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow="Insurance"
        title={t("insurance.title")}
        subtitle={`${formatCurrency(totalClaimed)} claimed across ${insuranceClaims.length} claims`}
      />

      <Card className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div className="flex items-center gap-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-cyan/10 text-cyan">
            <ShieldCheck size={20} />
          </span>
          <div>
            <p className="text-[15px] font-semibold">{patient.insurance}</p>
            <p className="text-[12px] text-text-tertiary">Policy holder · {patient.name}</p>
          </div>
        </div>
        <StatusPill label="Active" tone="emerald" />
      </Card>

      <Card className="p-0">
        <div className="border-b border-hairline p-5">
          <CardLabel>{t("label.claimsHistory")}</CardLabel>
        </div>
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
                <StatusPill label={c.status} tone={STATUS_TONE[c.status]} />
              </div>
            </motion.div>
          ))}
        </div>
      </Card>
    </div>
  );
}
