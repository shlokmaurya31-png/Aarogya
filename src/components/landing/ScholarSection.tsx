"use client";

import { motion } from "framer-motion";
import Link from "next/link";
import { ArrowRight, GraduationCap, Stethoscope, Pill, MessageSquareText, Siren, ShieldCheck } from "lucide-react";
import { SectionHeading } from "./SectionHeading";

const PILLARS = [
  { icon: Stethoscope, title: "Clinical Arena", text: "Take a history, examine, and build a differential before the diagnosis is ever revealed." },
  { icon: Siren, title: "Emergency Arena", text: "Sequence ABCDE decisions against a deteriorating simulated patient, against the clock." },
  { icon: Pill, title: "RxLab", text: "Write educational prescriptions checked for allergy, interaction and dosing safety." },
  { icon: MessageSquareText, title: "Viva AI", text: "Defend your reasoning to an adaptive AI examiner, one question at a time." },
  { icon: ShieldCheck, title: "Clinical Passport", text: "Track verified competencies, achievements and rotations across your training." },
];

export function ScholarSection() {
  return (
    <section id="scholar" className="relative mx-auto max-w-[1400px] px-6 py-28 sm:px-10 sm:py-36">
      <div className="flex flex-col items-start justify-between gap-8 lg:flex-row lg:items-end">
        <SectionHeading
          eyebrow="Aarogya Scholar"
          title="Learn medicine from cases that think back."
          subtitle="Practice clinical reasoning, diagnosis, investigations, prescriptions and emergency decisions in realistic patient simulations designed for verified healthcare students — medicine, nursing, pharmacy, diagnostics, physiotherapy and public health."
        />
        <Link
          href="/student"
          className="flex shrink-0 items-center gap-2 rounded-full bg-emerald px-5 py-2.5 text-[13px] font-medium text-white transition hover:brightness-110"
        >
          <GraduationCap size={15} /> Enter Aarogya Scholar <ArrowRight size={14} />
        </Link>
      </div>

      <div className="mt-16 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-5">
        {PILLARS.map((p, i) => {
          const Icon = p.icon;
          return (
            <motion.div
              key={p.title}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.6, delay: (i % 5) * 0.06, ease: [0.16, 1, 0.3, 1] }}
              className="group relative overflow-hidden rounded-[24px] border border-hairline bg-card p-6 transition-colors duration-300 hover:border-emerald/25"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl border border-emerald/20 bg-emerald/[0.07] text-emerald">
                <Icon size={18} />
              </span>
              <h3 className="mt-5 text-[15px] font-semibold tracking-tight text-text-primary">{p.title}</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-text-secondary">{p.text}</p>
            </motion.div>
          );
        })}
      </div>

      <p className="mt-8 text-[11.5px] text-text-tertiary">
        For education and simulation. Not for direct patient-care decisions. All cases are synthetic
        educational representations.
      </p>
    </section>
  );
}
