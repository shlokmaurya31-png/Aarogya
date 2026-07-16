"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Check } from "lucide-react";
import { upcomingMedicines, prescriptions } from "@/lib/mock-data";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Card, CardLabel } from "@/components/ui/Card";
import { cn } from "@/lib/utils";

export function PatientMedicinesView() {
  const [taken, setTaken] = useState<Record<string, boolean>>(
    Object.fromEntries(upcomingMedicines.map((m) => [m.id, m.taken]))
  );

  const active = prescriptions.filter((p) => p.status !== "completed");

  return (
    <div className="space-y-5">
      <SectionHeader
        eyebrow="Medicines"
        title="Today's medicines"
        subtitle="Tap each one off as you take it"
      />

      <Card>
        <div className="flex flex-col gap-2">
          {upcomingMedicines.map((m, i) => {
            const isTaken = taken[m.id];
            return (
              <motion.button
                key={m.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: i * 0.05 }}
                onClick={() => setTaken((t) => ({ ...t, [m.id]: !t[m.id] }))}
                className={cn(
                  "flex items-center gap-4 rounded-2xl px-4 py-3.5 text-left transition",
                  isTaken ? "bg-emerald/[0.06]" : "bg-white/[0.03] hover:bg-white/[0.05]"
                )}
              >
                <span
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                    isTaken ? "border-emerald bg-emerald text-ink" : "border-hairline-strong text-transparent"
                  )}
                >
                  <Check size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "truncate text-[14px] font-medium",
                      isTaken ? "text-text-tertiary line-through" : "text-text-primary"
                    )}
                  >
                    {m.name} <span className="font-normal">· {m.dose}</span>
                  </p>
                  <p className="text-[12px] text-text-tertiary">{m.time}</p>
                </div>
              </motion.button>
            );
          })}
        </div>
      </Card>

      <Card>
        <CardLabel>Your regular medicines</CardLabel>
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
                <button className="shrink-0 rounded-full border border-amber/30 bg-amber/10 px-3.5 py-1.5 text-[12px] font-medium text-amber transition hover:bg-amber/15">
                  Order refill
                </button>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
