"use client";

import { motion } from "framer-motion";
import {
  Fingerprint,
  FlaskConical,
  BrainCircuit,
  ShieldCheck,
  Languages,
  Siren,
} from "lucide-react";
import { SectionHeading } from "./SectionHeading";

const FEATURES = [
  {
    icon: Fingerprint,
    title: "One identity, every hospital",
    text: "A permanent health ID linked to Aadhaar and ABHA. Scan a QR at any facility in India and your full history is already there.",
    span: "lg:col-span-3",
  },
  {
    icon: FlaskConical,
    title: "Lab-verified, forgery-proof",
    text: "Results flow straight from the lab's machines into your record with cryptographic provenance. No paper ever changes hands.",
    span: "lg:col-span-3",
  },
  {
    icon: BrainCircuit,
    title: "AI that reads years in seconds",
    text: "A clinical model fine-tuned on SNOMED CT summarizes eight years of records into a three-paragraph brief before the doctor says hello.",
    span: "lg:col-span-2",
  },
  {
    icon: ShieldCheck,
    title: "You hold the keys",
    text: "DPDP-compliant consent on every access. Even we can't read your data without you.",
    span: "lg:col-span-2",
  },
  {
    icon: Languages,
    title: "Speaks your language",
    text: "Hindi, Tamil, Telugu, Bengali, Kannada — reports explained in words you actually use.",
    span: "lg:col-span-2",
  },
  {
    icon: Siren,
    title: "Emergency-ready",
    text: "Blood group, allergies and contacts reach first responders the moment SOS is triggered — with live ambulance tracking.",
    span: "lg:col-span-6",
  },
];

export function FeaturesSection() {
  return (
    <section id="features" className="relative mx-auto max-w-[1400px] px-6 py-28 sm:px-10 sm:py-36">
      <SectionHeading
        eyebrow="The platform"
        title="Infrastructure for a billion health records."
        subtitle="Six systems working as one — identity, verification, intelligence, consent, language, and emergency response."
      />

      <div className="mt-16 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-6">
        {FEATURES.map((f, i) => {
          const Icon = f.icon;
          return (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-60px" }}
              transition={{ duration: 0.6, delay: (i % 3) * 0.08, ease: [0.16, 1, 0.3, 1] }}
              className={`group relative overflow-hidden rounded-[24px] border border-hairline bg-card p-7 transition-colors duration-300 hover:border-cyan/25 ${f.span}`}
            >
              {/* hover glow */}
              <div
                aria-hidden
                className="pointer-events-none absolute -inset-x-8 -top-24 h-40 bg-cyan/10 opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-100"
              />
              <span className="relative flex h-10 w-10 items-center justify-center rounded-2xl border border-cyan/20 bg-cyan/[0.07] text-cyan">
                <Icon size={18} />
              </span>
              <h3 className="relative mt-5 text-[17px] font-semibold tracking-tight text-text-primary">
                {f.title}
              </h3>
              <p className="relative mt-2 max-w-lg text-[13.5px] leading-relaxed text-text-secondary">
                {f.text}
              </p>
            </motion.div>
          );
        })}
      </div>
    </section>
  );
}
