"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";
import { bodySystems } from "@/lib/mock-data";
import { RISK_COLOR, RISK_LABEL } from "@/lib/risk";
import { SYSTEM_FRIENDLY, RISK_FRIENDLY } from "@/lib/plain-language";
import { useUiStore } from "@/store/useUiStore";
import { usePatientStore } from "@/store/usePatientStore";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";

/** Per-system status list: replaces the old 3D anatomy view. Rows expand to metrics. */
export function SystemsCard() {
  const [openId, setOpenId] = useState<string | null>(null);
  const isPatient = useUiStore((s) => s.mode === "patient");
  const myBodySystems = usePatientStore((s) => s.bodySystems);
  const { t } = useTranslation();

  const systems = isPatient ? myBodySystems : bodySystems;

  return (
    <Card className="h-full p-0">
      <div className="border-b border-hairline p-5">
        <CardLabel>{isPatient ? t("label.bodySystemsPatient") : t("label.bodySystemsDoctor")}</CardLabel>
      </div>
      {systems.length === 0 && (
        <p className="px-5 py-8 text-center text-[12.5px] text-text-tertiary">
          {t("systemsCard.nothingTracked")}
        </p>
      )}
      <div className="divide-y divide-hairline">
        {systems.map((sys) => {
          const isOpen = openId === sys.id;
          const color = RISK_COLOR[sys.status];
          return (
            <div key={sys.id}>
              <button
                onClick={() => setOpenId(isOpen ? null : sys.id)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-3.5 px-5 py-3.5 text-left transition hover:bg-black/[0.025]"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: color, boxShadow: `0 0 8px ${color}88` }}
                />
                <span className="flex-1 text-[13.5px] font-medium text-text-primary">
                  {sys.name}
                </span>
                <span className="text-[11.5px]" style={{ color }}>
                  {isPatient ? RISK_FRIENDLY[sys.status].label : RISK_LABEL[sys.status]}
                </span>
                <ChevronDown
                  size={14}
                  className={cn(
                    "text-text-tertiary transition-transform duration-300",
                    isOpen && "rotate-180"
                  )}
                />
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-2.5 px-5 pb-4 pl-[42px]">
                      <p className="text-[12.5px] leading-relaxed text-text-secondary">
                        {isPatient ? SYSTEM_FRIENDLY[sys.id] : sys.summary}
                      </p>
                      {!isPatient && (
                        <div className="space-y-1.5 pt-1">
                          {sys.metrics.map((m) => (
                            <div key={m.label} className="flex items-center justify-between">
                              <span className="text-[11.5px] text-text-tertiary">{m.label}</span>
                              <span
                                className="tabular-nums text-[11.5px] font-medium"
                                style={{ color: RISK_COLOR[m.risk] }}
                              >
                                {m.value}
                              </span>
                            </div>
                          ))}
                          <p className="pt-1 text-[10.5px] text-text-tertiary">
                            {t("systemsCard.lastAssessed")} {sys.lastChecked}
                          </p>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
