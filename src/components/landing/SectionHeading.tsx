"use client";

import { motion } from "framer-motion";

/** Eyebrow + gradient-masked headline, revealed on scroll. */
export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  align = "left",
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
  align?: "left" | "center";
}) {
  const centered = align === "center";
  return (
    <div className={centered ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      <motion.p
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.6 }}
        className="text-[12px] font-medium uppercase tracking-[0.2em] text-cyan"
      >
        {eyebrow}
      </motion.p>
      <motion.h2
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.8, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
        className="mt-4 text-balance bg-gradient-to-b from-text-primary to-text-primary/60 bg-clip-text text-[clamp(1.9rem,4.2vw,3.2rem)] font-semibold leading-[1.04] tracking-tight text-transparent"
      >
        {title}
      </motion.h2>
      {subtitle && (
        <motion.p
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.7, delay: 0.16 }}
          className="mt-4 text-[15px] leading-relaxed text-text-secondary"
        >
          {subtitle}
        </motion.p>
      )}
    </div>
  );
}
