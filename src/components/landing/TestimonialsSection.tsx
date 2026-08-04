"use client";

import { motion } from "framer-motion";
import { SectionHeading } from "./SectionHeading";

const QUOTES = [
  {
    quote:
      "I used to spend the first twenty minutes of every consultation reconstructing history from memory and crumpled papers. Now it's on screen before the patient sits down.",
    name: "Dr. Rakesh Sharma",
    role: "Cardiologist · Fortis, Pune",
  },
  {
    quote:
      "My mother's diabetes records from three different cities are finally in one place. The app explains her reports to her in Marathi.",
    name: "Meera Kulkarni",
    role: "Patient · Pune",
  },
  {
    quote:
      "Direct upload ended the forged-report problem overnight. Our results carry our signature, mathematically.",
    name: "Priya Nair",
    role: "Lab Director · SRL Diagnostics",
  },
];

export function TestimonialsSection() {
  return (
    <section className="relative mx-auto max-w-[1400px] px-6 py-28 sm:px-10 sm:py-36">
      <SectionHeading
        align="center"
        eyebrow="Early voices"
        title="Three sides of the same record."
      />

      <div className="mt-14 grid grid-cols-1 gap-4 md:grid-cols-3">
        {QUOTES.map((q, i) => (
          <motion.figure
            key={q.name}
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.7, delay: i * 0.1, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col justify-between rounded-[24px] border border-hairline bg-card p-7 transition-colors duration-300 hover:border-hairline-strong"
          >
            <blockquote className="text-[14.5px] leading-relaxed text-text-secondary">
              &ldquo;{q.quote}&rdquo;
            </blockquote>
            <figcaption className="mt-6 border-t border-hairline pt-4">
              <p className="text-[13.5px] font-semibold text-text-primary">{q.name}</p>
              <p className="mt-0.5 text-[12px] text-text-tertiary">{q.role}</p>
            </figcaption>
          </motion.figure>
        ))}
      </div>

      <p className="mt-8 text-center text-[11px] text-text-tertiary">
        Illustrative voices from the product concept (pilot program opening 2026).
      </p>
    </section>
  );
}
