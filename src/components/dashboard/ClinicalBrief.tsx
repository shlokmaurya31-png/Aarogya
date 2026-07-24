"use client";

import { motion } from "framer-motion";
import { TriangleAlert } from "lucide-react";
import { Card, CardLabel } from "@/components/ui/Card";

const SOAP = [
  {
    key: "S",
    label: "Subjective",
    text: "Patient reports intermittent fatigue and occasional palpitations over the past 3 weeks. No chest pain at rest. Adherent to current medication regimen (self-reported 88–92%).",
  },
  {
    key: "O",
    label: "Objective",
    text: "BP 118/76 mmHg, HR 72 bpm, SpO2 98% RA. HbA1c 7.2% (↑ from 6.8% at last visit, 3-month trend). eGFR 76 mL/min/1.73m². LDL 118 mg/dL, HDL 52 mg/dL. Vitamin D 22 ng/mL.",
  },
  {
    key: "A",
    label: "Assessment",
    text: "1) Type 2 Diabetes Mellitus, suboptimal control (ICD-10 E11.65). 2) Essential Hypertension, controlled (I10). 3) Osteopenia, lumbar L3–L4 (M85.8). 4) Vitamin D insufficiency (E55.9).",
  },
  {
    key: "P",
    label: "Plan",
    text: "Continue Metformin 500mg BID, Atorvastatin 10mg qHS. Initiate Vitamin D3 60,000 IU weekly ×8. Repeat HbA1c + lipid panel in 12 weeks. Cardiology follow-up scheduled for interaction review.",
  },
];

export function ClinicalBrief() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
    >
      <Card>
        <div className="flex items-center justify-between">
          <CardLabel>AI Clinical Brief · SNOMED CT structured</CardLabel>
          <span className="rounded-full border border-hairline px-2.5 py-1 text-[10.5px] text-text-tertiary">
            Generated in 1.4s
          </span>
        </div>

        <div className="mt-3 flex items-start gap-2 rounded-2xl border border-amber/25 bg-amber/[0.08] px-3.5 py-3">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber" />
          <p className="text-[12px] leading-relaxed text-amber">
            Interaction flag: existing ACE inhibitor (lisinopril, per Jan 2026 record) may
            potentiate hypotensive effect with newly initiated statin — recommend dose review.
          </p>
        </div>

        <dl className="mt-4 space-y-3.5">
          {SOAP.map((s) => (
            <div key={s.key} className="flex gap-3">
              <dt className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-black/[0.045] text-[11px] font-semibold text-cyan">
                {s.key}
              </dt>
              <dd className="min-w-0 flex-1">
                <p className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary">
                  {s.label}
                </p>
                <p className="mt-0.5 text-[13px] leading-relaxed text-text-secondary">{s.text}</p>
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </motion.div>
  );
}
