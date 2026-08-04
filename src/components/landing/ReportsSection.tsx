"use client";

import { motion } from "framer-motion";
import { FileX2, BadgeCheck, X, Check } from "lucide-react";
import { SectionHeading } from "./SectionHeading";

const BEFORE = [
  "A plastic bag of crumpled prescriptions",
  "Lab reports that contradict each other",
  "Every new doctor starts from zero",
  "Reports altered for fraudulent claims",
];

const AFTER = [
  "One structured, lifelong record",
  "Lab-signed results, mathematically unforgeable",
  "Any doctor briefed in under ten seconds",
  "Claims auto-verified against source data",
];

export function ReportsSection() {
  return (
    <section className="relative mx-auto max-w-[1400px] px-6 py-28 sm:px-10 sm:py-36">
      <SectionHeading
        eyebrow="Records"
        title="From a plastic bag of papers to a verified record."
      />

      <div className="mt-14 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <motion.div
          initial={{ opacity: 0, x: -24 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="rounded-[28px] border border-hairline bg-card/50 p-8"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-black/[0.045] text-text-tertiary">
              <FileX2 size={17} />
            </span>
            <h3 className="text-[16px] font-semibold text-text-secondary">Healthcare today</h3>
          </div>
          <ul className="mt-6 space-y-4">
            {BEFORE.map((item) => (
              <li key={item} className="flex items-start gap-3 text-[14px] text-text-tertiary">
                <X size={15} className="mt-0.5 shrink-0 text-red/60" />
                {item}
              </li>
            ))}
          </ul>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, x: 24 }}
          whileInView={{ opacity: 1, x: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.7, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
          className="relative overflow-hidden rounded-[28px] border border-cyan/20 bg-card p-8"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute -top-20 right-0 h-40 w-2/3 bg-cyan/[0.08] blur-3xl"
          />
          <div className="relative flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl border border-cyan/25 bg-cyan/10 text-cyan">
              <BadgeCheck size={17} />
            </span>
            <h3 className="text-[16px] font-semibold text-text-primary">With Aarogya</h3>
          </div>
          <ul className="relative mt-6 space-y-4">
            {AFTER.map((item) => (
              <li key={item} className="flex items-start gap-3 text-[14px] text-text-secondary">
                <Check size={15} className="mt-0.5 shrink-0 text-cyan" />
                {item}
              </li>
            ))}
          </ul>
        </motion.div>
      </div>
    </section>
  );
}
