"use client";

import { motion } from "framer-motion";
import { SectionHeading } from "./SectionHeading";
import { Counter } from "./Counter";

const STATS = [
  { to: 670, suffix: "M+", label: "ABHA health IDs already issued in India" },
  { to: 1.38, decimals: 2, suffix: "M", label: "Registered doctors the platform is built for" },
  { to: 50, suffix: "K+", label: "Diagnostic labs ready for direct upload" },
  { to: 6, suffix: " hrs", label: "Insurance claims, down from 3 weeks" },
];

export function AnalyticsSection() {
  return (
    <section className="relative border-y border-hairline bg-surface px-6 py-24 sm:px-10 sm:py-28">
      <div className="mx-auto max-w-[1400px]">
        <SectionHeading
          eyebrow="The scale"
          title="Built for a country, not a clinic."
        />
        <div className="mt-14 grid grid-cols-2 gap-x-8 gap-y-12 lg:grid-cols-4">
          {STATS.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.6, delay: i * 0.08 }}
            >
              <p className="bg-gradient-to-b from-text-primary to-text-primary/50 bg-clip-text text-[clamp(2.4rem,5vw,4rem)] font-semibold leading-none tracking-tight text-transparent">
                <Counter to={s.to} suffix={s.suffix} decimals={s.decimals ?? 0} />
              </p>
              <p className="mt-3 max-w-[220px] text-[13px] leading-relaxed text-text-secondary">
                {s.label}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
