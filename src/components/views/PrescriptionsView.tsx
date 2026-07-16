"use client";

import { motion } from "framer-motion";
import { prescriptions } from "@/lib/mock-data";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/StatusPill";
import type { PrescriptionStatus } from "@/types";

const STATUS_TONE: Record<PrescriptionStatus, "emerald" | "amber" | "neutral"> = {
  active: "emerald",
  "refill-due": "amber",
  completed: "neutral",
};

const STATUS_LABEL: Record<PrescriptionStatus, string> = {
  active: "Active",
  "refill-due": "Refill due",
  completed: "Completed",
};

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function PrescriptionsView() {
  const refillDue = prescriptions.filter((p) => p.status === "refill-due").length;

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow="Prescriptions"
        title="Current medications"
        subtitle={
          refillDue > 0
            ? `${refillDue} medication needs a refill soon`
            : "All medications are up to date"
        }
      />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {prescriptions.map((p, i) => (
          <motion.div
            key={p.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: i * 0.05 }}
          >
            <Card className="h-full">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[14px] font-semibold">
                    {p.drug} <span className="font-normal text-text-tertiary">{p.dose}</span>
                  </p>
                  <p className="mt-0.5 text-[12px] text-text-secondary">{p.frequency}</p>
                </div>
                <StatusPill label={STATUS_LABEL[p.status]} tone={STATUS_TONE[p.status]} />
              </div>

              <div className="mt-4 flex items-center justify-between text-[11.5px] text-text-tertiary">
                <span>Prescribed by {p.prescribedBy}</span>
                <span className="tabular-nums">since {formatDate(p.startDate)}</span>
              </div>

              <div className="mt-3">
                <div className="mb-1.5 flex items-center justify-between text-[11px] text-text-tertiary">
                  <span>Adherence</span>
                  <span className="tabular-nums font-medium text-text-secondary">{p.adherence}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${p.adherence}%` }}
                    transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
                    className="h-full rounded-full bg-emerald"
                  />
                </div>
              </div>

              {p.status === "refill-due" && (
                <button className="mt-4 w-full rounded-full border border-amber/30 bg-amber/10 py-2 text-[12px] font-medium text-amber transition hover:bg-amber/15">
                  Request refill
                </button>
              )}
            </Card>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
