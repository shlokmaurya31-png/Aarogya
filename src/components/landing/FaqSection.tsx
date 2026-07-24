"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Plus } from "lucide-react";
import { SectionHeading } from "./SectionHeading";
import { cn } from "@/lib/utils";

const FAQS = [
  {
    q: "Is my health data safe?",
    a: "Your record is encrypted with keys only you control — even Aarogya cannot read it without your consent. Every access event is logged and visible to you, as required by the DPDP Act 2023.",
  },
  {
    q: "Is it really free for patients?",
    a: "Yes — free, forever. Like UPI, patients never pay. The platform is funded by the doctors, hospitals, labs and insurers whose work it makes faster.",
  },
  {
    q: "Does it work with my existing ABHA ID?",
    a: "Aarogya is built natively on ABDM. If you already have an ABHA number, your ID links in one step. If you don't, we create one for you during signup.",
  },
  {
    q: "What if I don't have a smartphone?",
    a: "A WhatsApp-first flow covers feature phones and shared devices, and your health QR can be printed on paper. Family accounts let one member manage records for the whole household.",
  },
  {
    q: "Can my doctor refuse to use it?",
    a: "Doctors keep their own workflow — Aarogya appears as a single scan-to-view screen that saves them 30–45 minutes a day. Adoption is voluntary, but the time saved tends to make the argument.",
  },
];

export function FaqSection() {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <section className="relative mx-auto max-w-3xl px-6 py-28 sm:px-10 sm:py-36">
      <SectionHeading align="center" eyebrow="Questions" title="Asked, answered." />

      <div className="mt-12 divide-y divide-hairline border-y border-hairline">
        {FAQS.map((f, i) => {
          const isOpen = open === i;
          return (
            <div key={f.q}>
              <button
                onClick={() => setOpen(isOpen ? null : i)}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between gap-4 py-6 text-left"
              >
                <span
                  className={cn(
                    "text-[15.5px] font-medium transition-colors",
                    isOpen ? "text-text-primary" : "text-text-secondary"
                  )}
                >
                  {f.q}
                </span>
                <motion.span
                  animate={{ rotate: isOpen ? 45 : 0 }}
                  transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                  className={cn("shrink-0 transition-colors", isOpen ? "text-cyan" : "text-text-tertiary")}
                >
                  <Plus size={17} />
                </motion.span>
              </button>
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                    className="overflow-hidden"
                  >
                    <p className="pb-6 pr-10 text-[14px] leading-relaxed text-text-secondary">
                      {f.a}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </div>
    </section>
  );
}
