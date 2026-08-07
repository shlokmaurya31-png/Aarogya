"use client";

import { useState } from "react";
import { Pill } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card, CardLabel } from "@/components/ui/Card";
import { useToastStore } from "@/store/useToastStore";
import { usePatientStore } from "@/store/usePatientStore";
import { useTranslation } from "@/hooks/useTranslation";

export function PatientMedicinesView() {
  const prescriptions = usePatientStore((s) => s.prescriptions);
  const active = prescriptions.filter((p) => p.status !== "completed");
  const [ordered, setOrdered] = useState<Set<string>>(new Set());
  const push = useToastStore((s) => s.push);
  const { t } = useTranslation();

  function orderRefill(id: string, drug: string) {
    setOrdered((s) => new Set(s).add(id));
    push(`${t("patientMedicines.refillOrderedFor")} ${drug}${t("patientMedicines.onItsWay")}`, "amber");
  }

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow={t("nav.medicines")}
        title={t("patientHome.medicinesTitle")}
        subtitle={t("patientMedicines.subtitle")}
      />

      <Card>
        <CardLabel>{t("patientMedicines.regularMedicines")}</CardLabel>
        {active.length === 0 ? (
          <div className="mt-4 flex flex-col items-center gap-2 py-8 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-black/[0.045] text-text-tertiary">
              <Pill size={18} />
            </span>
            <p className="text-[13px] text-text-secondary">{t("patientMedicines.emptyState")}</p>
          </div>
        ) : (
          <div className="mt-3 divide-y divide-hairline">
            {active.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <p className="text-[13.5px] font-medium text-text-primary">
                    {p.drug} <span className="font-normal text-text-tertiary">{p.dose}</span>
                  </p>
                  <p className="text-[12px] text-text-tertiary">{p.frequency}</p>
                </div>
                {p.status === "refill-due" && (
                  <button
                    onClick={() => orderRefill(p.id, p.drug)}
                    disabled={ordered.has(p.id)}
                    className="shrink-0 rounded-full border border-amber/30 bg-amber/10 px-3.5 py-1.5 text-[12px] font-medium text-amber transition hover:bg-amber/15 disabled:cursor-default disabled:opacity-60"
                  >
                    {ordered.has(p.id) ? t("btn.ordered") : t("btn.orderRefill")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
