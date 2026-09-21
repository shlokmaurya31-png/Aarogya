"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { MagneticButton } from "./MagneticButton";

type FooterLink = { label: string; href?: string };

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: "Platform",
    links: [
      { label: "Patients", href: "/patient/login" },
      { label: "Doctors", href: "/login" },
      { label: "Hospitals", href: "/login" },
      { label: "Labs", href: "/login" },
      { label: "Insurers", href: "/login" },
    ],
  },
  {
    title: "Standards",
    links: [
      { label: "ABDM", href: "/standards/abdm" },
      { label: "ABHA", href: "/standards/abha" },
      { label: "DPDP Act 2023", href: "/standards/dpdp" },
      { label: "FHIR R4", href: "/standards/fhir" },
      { label: "SNOMED CT", href: "/standards/snomed" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/company/about" },
      { label: "Careers", href: "/company/careers" },
      { label: "Press", href: "/company/press" },
      { label: "Contact", href: "/company/contact" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="noise relative overflow-hidden border-t border-hairline bg-surface">
      {/* closing CTA */}
      <div className="mx-auto max-w-[1400px] px-6 py-24 text-center sm:px-10 sm:py-32">
        <motion.h2
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto max-w-3xl text-balance bg-gradient-to-b from-text-primary to-text-primary/55 bg-clip-text text-[clamp(2.2rem,6vw,4.5rem)] font-semibold leading-[1.02] tracking-tight text-transparent"
        >
          Your health deserves a memory.
        </motion.h2>
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.7, delay: 0.15 }}
          className="mt-9"
        >
          <Link href="/login">
            <MagneticButton className="bg-[#0a0a0a] text-white hover:bg-cyan">
              Enter Aarogya <ArrowRight size={15} />
            </MagneticButton>
          </Link>
        </motion.div>
      </div>

      {/* link columns */}
      <div className="mx-auto grid max-w-[1400px] grid-cols-2 gap-10 border-t border-hairline px-6 py-14 sm:px-10 md:grid-cols-4">
        <div className="col-span-2 md:col-span-1">
          <p className="flex items-center gap-2 text-[14px] font-semibold">
            <span className="h-2 w-2 rounded-full bg-cyan shadow-[0_0_12px_2px_rgba(120,200,255,0.5)]" />
            Aarogya AI
          </p>
          <p className="mt-3 max-w-[220px] text-[12.5px] leading-relaxed text-text-tertiary">
            India&rsquo;s unified health intelligence platform. One record, every hospital, for life.
          </p>
        </div>
        {COLUMNS.map((col) => (
          <div key={col.title}>
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-text-tertiary">
              {col.title}
            </p>
            <ul className="mt-4 space-y-2.5">
              {col.links.map((l) => (
                <li key={l.label}>
                  {l.href ? (
                    <Link
                      href={l.href}
                      className="text-[13px] text-text-secondary transition-colors hover:text-text-primary"
                    >
                      {l.label}
                    </Link>
                  ) : (
                    <span className="text-[13px] text-text-secondary">{l.label}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* giant wordmark */}
      <div aria-hidden className="pointer-events-none select-none overflow-hidden">
        <p className="translate-y-[22%] bg-gradient-to-b from-black/[0.06] to-transparent bg-clip-text text-center text-[clamp(5rem,18vw,16rem)] font-bold leading-none tracking-tighter text-transparent">
          AAROGYA
        </p>
      </div>

      <div className="relative border-t border-hairline">
        <div className="mx-auto flex max-w-[1400px] flex-col items-start justify-between gap-3 px-6 py-6 text-[12px] text-text-tertiary sm:flex-row sm:items-center sm:px-10">
          <span>© 2026 Aarogya AI · Aparix Ventures</span>
          <span>Made in India, for India, and beyond.</span>
        </div>
      </div>
    </footer>
  );
}
