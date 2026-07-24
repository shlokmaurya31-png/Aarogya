"use client";

import { useRef } from "react";
import { motion, useScroll, useSpring } from "framer-motion";
import { SectionHeading } from "./SectionHeading";
import { timeline } from "@/lib/mock-data";
import { TIMELINE_TYPE_META, formatEventDate } from "@/lib/timeline-meta";

export function TimelineSection() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 75%", "end 60%"],
  });
  const lineScale = useSpring(scrollYProgress, { stiffness: 80, damping: 24 });

  return (
    <section id="timeline" className="relative mx-auto max-w-[1400px] px-6 py-28 sm:px-10 sm:py-36">
      <SectionHeading
        eyebrow="Longitudinal record"
        title="A health story that never loses a chapter."
        subtitle="Every visit, test and vaccination — across every hospital, city and year — in one continuous record."
      />

      <div ref={ref} className="relative mx-auto mt-16 max-w-3xl">
        {/* spine that draws in as you scroll */}
        <div aria-hidden className="absolute left-[19px] top-0 h-full w-px bg-black/[0.08]" />
        <motion.div
          aria-hidden
          style={{ scaleY: lineScale, transformOrigin: "top" }}
          className="absolute left-[19px] top-0 h-full w-px bg-gradient-to-b from-cyan/70 via-cyan/40 to-transparent"
        />

        <div className="space-y-10">
          {timeline.map((event, i) => {
            const meta = TIMELINE_TYPE_META[event.type];
            const Icon = meta.icon;
            return (
              <motion.div
                key={event.id}
                initial={{ opacity: 0, x: 24 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, margin: "-100px" }}
                transition={{ duration: 0.6, delay: i * 0.04, ease: [0.16, 1, 0.3, 1] }}
                className="relative flex gap-6 pl-0"
              >
                <span
                  className="z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-hairline bg-ink"
                  style={{ color: meta.color, boxShadow: `0 0 20px -6px ${meta.color}66` }}
                >
                  <Icon size={15} />
                </span>
                <div className="flex-1 rounded-[20px] border border-hairline bg-card p-5 transition-colors duration-300 hover:border-hairline-strong">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-[15px] font-semibold text-text-primary">{event.title}</h3>
                    <span className="font-mono text-[11.5px] tabular-nums text-text-tertiary">
                      {formatEventDate(event.date)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[12px] text-text-tertiary">{event.facility}</p>
                  <p className="mt-2.5 text-[13.5px] leading-relaxed text-text-secondary">
                    {event.description}
                  </p>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
