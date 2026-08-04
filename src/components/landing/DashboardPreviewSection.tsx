"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Activity, Droplet, HeartPulse, Moon } from "lucide-react";
import { SectionHeading } from "./SectionHeading";
import { MagneticButton } from "./MagneticButton";

const TILES = [
  { icon: HeartPulse, label: "Heart Rate", value: "72", unit: "bpm", color: "#dc2626" },
  { icon: Activity, label: "Blood Pressure", value: "118/76", unit: "mmHg", color: "#0e7490" },
  { icon: Droplet, label: "Blood Sugar", value: "142", unit: "mg/dL", color: "#b45309" },
  { icon: Moon, label: "Sleep", value: "6.8", unit: "hrs", color: "#15803d" },
];

const BARS = [42, 58, 45, 70, 62, 78, 66, 84, 72, 90, 80, 95];

export function DashboardPreviewSection() {
  return (
    <section className="relative mx-auto max-w-[1400px] px-6 py-28 sm:px-10 sm:py-36">
      <SectionHeading
        align="center"
        eyebrow="The product"
        title="A dashboard that already knows you."
        subtitle="Vitals, medication, appointments and AI insight — visible in the first five seconds."
      />

      <motion.div
        initial={{ opacity: 0, y: 40, rotateX: 6 }}
        whileInView={{ opacity: 1, y: 0, rotateX: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
        style={{ perspective: 1200 }}
        className="mx-auto mt-14 max-w-4xl"
      >
        {/* browser chrome */}
        <div className="overflow-hidden rounded-[24px] border border-hairline bg-card shadow-[0_40px_80px_-32px_rgba(0,0,0,0.3)]">
          <div className="flex items-center gap-2 border-b border-hairline bg-surface px-5 py-3.5">
            {["#dc2626", "#b45309", "#15803d"].map((c) => (
              <span key={c} className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: c + "66" }} />
            ))}
            <span className="ml-4 rounded-full bg-black/[0.045] px-3 py-1 font-mono text-[10.5px] text-text-tertiary">
              aarogya.ai/dashboard
            </span>
          </div>

          <div className="p-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {TILES.map((t, i) => {
                const Icon = t.icon;
                return (
                  <motion.div
                    key={t.label}
                    initial={{ opacity: 0, y: 14 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: 0.3 + i * 0.08 }}
                    className="rounded-2xl border border-hairline bg-black/[0.025] p-4"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[10.5px] uppercase tracking-[0.1em] text-text-tertiary">
                        {t.label}
                      </span>
                      <Icon size={13} style={{ color: t.color }} />
                    </div>
                    <p className="mt-2 tabular-nums text-[20px] font-semibold text-text-primary">
                      {t.value}
                      <span className="ml-1 text-[11px] font-normal text-text-tertiary">{t.unit}</span>
                    </p>
                  </motion.div>
                );
              })}
            </div>

            {/* animated bar chart */}
            <div className="mt-4 rounded-2xl border border-hairline bg-black/[0.025] p-4">
              <span className="text-[10.5px] uppercase tracking-[0.1em] text-text-tertiary">
                Medication adherence · 12 weeks
              </span>
              <div className="mt-4 flex h-24 items-end gap-2">
                {BARS.map((h, i) => (
                  <motion.div
                    key={i}
                    initial={{ height: 0 }}
                    whileInView={{ height: `${h}%` }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.7, delay: 0.5 + i * 0.04, ease: [0.16, 1, 0.3, 1] }}
                    className="flex-1 rounded-t-md bg-gradient-to-t from-cyan/20 to-cyan/70"
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      <div className="mt-12 text-center">
        <Link href="/login">
          <MagneticButton className="bg-[#0a0a0a] text-white hover:bg-cyan">
            Open the live dashboard <ArrowRight size={15} />
          </MagneticButton>
        </Link>
      </div>
    </section>
  );
}
