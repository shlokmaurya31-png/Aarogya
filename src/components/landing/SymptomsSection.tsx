"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { SectionHeading } from "./SectionHeading";
import { cn } from "@/lib/utils";

const SYMPTOMS = [
  "Fatigue",
  "Chest discomfort",
  "Frequent thirst",
  "Headache",
  "Joint pain",
  "Shortness of breath",
  "Dizziness",
  "Blurred vision",
];

/** Deliberately cautious, triage-style copy — the AI assists, it never diagnoses. */
function triage(selected: string[]): { level: string; color: string; advice: string } {
  if (selected.includes("Chest discomfort") || selected.includes("Shortness of breath")) {
    return {
      level: "See a doctor soon",
      color: "#f8c84b",
      advice:
        "Chest-related symptoms deserve prompt attention. Aarogya would book you a cardiology slot and share your history before you arrive.",
    };
  }
  if (selected.length >= 3) {
    return {
      level: "Worth a consultation",
      color: "#78c8ff",
      advice:
        "This combination is worth discussing with a doctor. Aarogya would suggest the right specialist and prepare your records for the visit.",
    };
  }
  return {
    level: "Monitor at home",
    color: "#8fe388",
    advice:
      "Nothing urgent by itself. Aarogya would log this against your history and alert you if a pattern starts forming.",
  };
}

export function SymptomsSection() {
  const [selected, setSelected] = useState<string[]>([]);
  const result = selected.length > 0 ? triage(selected) : null;

  function toggle(s: string) {
    setSelected((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  return (
    <section className="relative border-y border-hairline bg-surface px-6 py-28 sm:px-10 sm:py-36">
      <div className="mx-auto max-w-[1400px]">
        <SectionHeading
          align="center"
          eyebrow="Try it"
          title="Tell it how you feel. Watch it think."
          subtitle="Select a few symptoms — this is the same triage engine that runs inside the app."
        />

        <div className="mx-auto mt-12 flex max-w-2xl flex-wrap justify-center gap-2.5">
          {SYMPTOMS.map((s) => {
            const active = selected.includes(s);
            return (
              <button
                key={s}
                onClick={() => toggle(s)}
                aria-pressed={active}
                className={cn(
                  "rounded-full border px-4 py-2 text-[13px] transition-all duration-200 active:scale-95",
                  active
                    ? "border-cyan/50 bg-cyan/15 text-cyan shadow-[0_0_20px_-6px_rgba(120,200,255,0.5)]"
                    : "border-hairline bg-white/[0.03] text-text-secondary hover:border-hairline-strong hover:text-white"
                )}
              >
                {s}
              </button>
            );
          })}
        </div>

        <div className="mx-auto mt-8 max-w-xl">
          <AnimatePresence mode="wait">
            {result && (
              <motion.div
                key={result.level}
                initial={{ opacity: 0, y: 14, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.98 }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="rounded-[24px] border border-hairline bg-card p-6"
              >
                <div className="flex items-center gap-2.5">
                  <Sparkles size={14} className="text-cyan" />
                  <span
                    className="rounded-full border px-3 py-1 text-[11.5px] font-medium"
                    style={{
                      color: result.color,
                      borderColor: result.color + "40",
                      backgroundColor: result.color + "14",
                    }}
                  >
                    {result.level}
                  </span>
                </div>
                <p className="mt-3.5 text-[13.5px] leading-relaxed text-text-secondary">
                  {result.advice}
                </p>
                <p className="mt-3 text-[11px] text-text-tertiary">
                  Guidance only — Aarogya assists, your doctor decides.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}
