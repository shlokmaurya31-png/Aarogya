"use client";

import { motion } from "framer-motion";
import { Card, CardLabel } from "@/components/ui/Card";
import { usePatientStore } from "@/store/usePatientStore";
import { overallStatus } from "@/lib/plain-language";
import { Counter } from "@/components/landing/Counter";
import { useTranslation } from "@/hooks/useTranslation";

const SCORE = 86;
const R = 64;
const CIRC = 2 * Math.PI * R;

export function HealthScoreCard() {
  const vitals = usePatientStore((s) => s.vitals);
  const { t } = useTranslation();

  if (vitals.length === 0) {
    return (
      <Card className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <CardLabel>{t("label.healthScore")}</CardLabel>
        <div className="flex h-40 w-40 items-center justify-center rounded-full border-2 border-dashed border-hairline-strong">
          <span className="text-[11px] text-text-tertiary">No data yet</span>
        </div>
        <p className="max-w-[220px] text-[12.5px] leading-relaxed text-text-secondary">
          Your score builds up once a report is uploaded or a doctor adds a checkup.
        </p>
      </Card>
    );
  }

  const status = overallStatus(vitals.map((v) => v.risk));

  return (
    <Card className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
      <CardLabel>{t("label.healthScore")}</CardLabel>

      <div className="relative h-40 w-40">
        <svg viewBox="0 0 160 160" className="h-full w-full -rotate-90">
          <circle cx="80" cy="80" r={R} fill="none" stroke="rgba(0,0,0,0.08)" strokeWidth="10" />
          <motion.circle
            cx="80"
            cy="80"
            r={R}
            fill="none"
            stroke={status.color}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={CIRC}
            initial={{ strokeDashoffset: CIRC }}
            animate={{ strokeDashoffset: CIRC * (1 - SCORE / 100) }}
            transition={{ duration: 1.6, delay: 0.3, ease: [0.16, 1, 0.3, 1] }}
            style={{ filter: `drop-shadow(0 0 10px ${status.color}55)` }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="tabular-nums text-[40px] font-semibold leading-none text-text-primary">
            <Counter to={SCORE} duration={1.6} />
          </span>
          <span className="mt-1 text-[11px] text-text-tertiary">{t("label.outOf100")}</span>
        </div>
      </div>

      <div>
        <p className="text-[15px] font-semibold" style={{ color: status.color }}>
          {status.label}
        </p>
        <p className="mt-1 max-w-[220px] text-[12.5px] leading-relaxed text-text-secondary">
          {status.message}
        </p>
      </div>
    </Card>
  );
}
