"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Check } from "lucide-react";
import { SectionHeading } from "./SectionHeading";
import { cn } from "@/lib/utils";

const TIERS = [
  {
    name: "Patient",
    price: "Free",
    period: "forever",
    tagline: "Your record belongs to you.",
    features: [
      "Lifelong health record",
      "AI report explanations",
      "Medicine reminders",
      "Family accounts",
      "Emergency SOS",
    ],
    cta: "Create your record",
    featured: false,
  },
  {
    name: "Doctor Pro",
    price: "₹3,500",
    period: "/month",
    tagline: "Full context before hello.",
    features: [
      "Instant patient history on QR scan",
      "AI clinical briefs (SOAP)",
      "Real-time interaction alerts",
      "Digital prescriptions",
      "Analytics dashboard",
      "Priority support",
    ],
    cta: "Start free trial",
    featured: true,
  },
  {
    name: "Hospital",
    price: "Custom",
    period: "per facility",
    tagline: "Network-wide, EMR-integrated.",
    features: [
      "Institution-wide licensing",
      "EMR integration",
      "Insurance claim automation",
      "Population health dashboard",
      "Dedicated onboarding",
    ],
    cta: "Talk to us",
    featured: false,
  },
];

export function PricingSection() {
  return (
    <section id="pricing" className="relative mx-auto max-w-[1400px] px-6 py-28 sm:px-10 sm:py-36">
      <SectionHeading
        align="center"
        eyebrow="Pricing"
        title="Free for patients. Priced for the people it pays back."
        subtitle="Doctors save 30–45 minutes a day. Hospitals process claims in hours instead of weeks."
      />

      <div className="mx-auto mt-14 grid max-w-5xl grid-cols-1 gap-4 md:grid-cols-3">
        {TIERS.map((t, i) => (
          <motion.div
            key={t.name}
            initial={{ opacity: 0, y: 28 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.7, delay: i * 0.1, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "relative flex flex-col rounded-[28px] border p-8",
              t.featured
                ? "border-cyan/30 bg-card shadow-[0_0_60px_-20px_rgba(120,200,255,0.25)]"
                : "border-hairline bg-card/60"
            )}
          >
            {t.featured && (
              <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full border border-cyan/40 bg-ink px-3 py-1 text-[10.5px] font-medium uppercase tracking-[0.1em] text-cyan">
                Most adopted
              </span>
            )}
            <h3 className="text-[14px] font-medium uppercase tracking-[0.12em] text-text-tertiary">
              {t.name}
            </h3>
            <p className="mt-3 flex items-baseline gap-1.5">
              <span className="text-[36px] font-semibold tracking-tight text-white">{t.price}</span>
              <span className="text-[12.5px] text-text-tertiary">{t.period}</span>
            </p>
            <p className="mt-1 text-[13px] text-text-secondary">{t.tagline}</p>

            <ul className="mt-7 flex-1 space-y-3">
              {t.features.map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-[13.5px] text-text-secondary">
                  <Check size={14} className={cn("mt-0.5 shrink-0", t.featured ? "text-cyan" : "text-text-tertiary")} />
                  {f}
                </li>
              ))}
            </ul>

            <Link
              href="/dashboard"
              className={cn(
                "mt-8 rounded-full py-3 text-center text-[13.5px] font-medium transition active:scale-[0.98]",
                t.featured
                  ? "bg-cyan text-ink hover:brightness-110"
                  : "border border-hairline text-text-secondary hover:border-cyan/30 hover:text-cyan"
              )}
            >
              {t.cta}
            </Link>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
