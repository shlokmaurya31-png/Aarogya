"use client";

import { useRef } from "react";
import { motion, useInView } from "framer-motion";
import { Sparkles, FileSearch, TriangleAlert, TrendingUp } from "lucide-react";
import { SectionHeading } from "./SectionHeading";
import { StreamingText } from "@/components/ai/StreamingText";

const BRIEF =
  "42F · T2DM, essential HTN. HbA1c 7.2%, rising 0.4%/quarter over 3 quarters. eGFR 76 mL/min, trending down. Flag: prescribed statin may interact with existing ACE inhibitor. Recommend dose review before dispensing. Overall risk: moderate, actionable.";

const CAPABILITIES = [
  {
    icon: FileSearch,
    title: "Explains any report",
    text: "Reads scans, panels and discharge summaries, then briefs the doctor like a senior colleague would.",
  },
  {
    icon: TriangleAlert,
    title: "Catches interactions first",
    text: "Every new prescription is checked against everything the patient already takes, in real time.",
  },
  {
    icon: TrendingUp,
    title: "Sees trends humans miss",
    text: "Three years of slowly rising HbA1c is invisible in a single visit. It isn't to Aarogya.",
  },
];

export function AiDiagnosisSection() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const inView = useInView(terminalRef, { once: true, margin: "-120px" });

  return (
    <section className="relative mx-auto max-w-[1400px] px-6 py-28 sm:px-10 sm:py-36">
      <div className="grid grid-cols-1 items-center gap-14 lg:grid-cols-2">
        <div>
          <SectionHeading
            eyebrow="Clinical intelligence"
            title="A second opinion, before the first one."
            subtitle="Aarogya's model is fine-tuned on structured Indian clinical data, not a chatbot bolted onto a database."
          />
          <div className="mt-10 space-y-6">
            {CAPABILITIES.map((c, i) => {
              const Icon = c.icon;
              return (
                <motion.div
                  key={c.title}
                  initial={{ opacity: 0, x: -18 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true, margin: "-60px" }}
                  transition={{ duration: 0.6, delay: i * 0.1, ease: [0.16, 1, 0.3, 1] }}
                  className="flex gap-4"
                >
                  <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-hairline bg-black/[0.035] text-cyan">
                    <Icon size={16} />
                  </span>
                  <div>
                    <h3 className="text-[15px] font-semibold text-text-primary">{c.title}</h3>
                    <p className="mt-1 max-w-sm text-[13.5px] leading-relaxed text-text-secondary">
                      {c.text}
                    </p>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </div>

        {/* streaming clinical brief */}
        <motion.div
          ref={terminalRef}
          initial={{ opacity: 0, y: 28, scale: 0.98 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true, margin: "-120px" }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="relative overflow-hidden rounded-[28px] border border-hairline bg-card p-1"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute -top-20 left-1/2 h-40 w-3/4 -translate-x-1/2 bg-cyan/10 blur-3xl"
          />
          <div className="rounded-[24px] bg-black/[0.025] p-6">
            <div className="flex items-center justify-between border-b border-hairline pb-4">
              <div className="flex items-center gap-2.5">
                <span className="flex h-7 w-7 items-center justify-center rounded-full border border-cyan/25 bg-cyan/10">
                  <Sparkles size={13} className="text-cyan" />
                </span>
                <span className="text-[13px] font-medium text-text-primary">Clinical brief</span>
              </div>
              <span className="font-mono text-[11px] text-text-tertiary">1.4s · 8 yrs of records</span>
            </div>
            <p className="mt-5 min-h-[150px] font-mono text-[13px] leading-[1.75] text-text-secondary">
              {inView && <StreamingText text={BRIEF} speed={18} />}
              <motion.span
                animate={{ opacity: [1, 0] }}
                transition={{ duration: 0.8, repeat: Infinity }}
                className="ml-0.5 inline-block h-[1em] w-[7px] translate-y-[2px] bg-cyan/70"
              />
            </p>
            <div className="mt-5 flex flex-wrap gap-2 border-t border-hairline pt-4">
              {["SNOMED CT", "FHIR R4", "Drug interaction engine"].map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-hairline px-2.5 py-1 font-mono text-[10.5px] text-text-tertiary"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
