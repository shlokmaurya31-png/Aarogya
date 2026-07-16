"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { timeline } from "@/lib/mock-data";
import { Card, CardLabel } from "@/components/ui/Card";
import { cn } from "@/lib/utils";
import { TIMELINE_TYPE_META as TYPE_META, formatEventDate as formatDate } from "@/lib/timeline-meta";

export function HealthTimeline() {
  const [openId, setOpenId] = useState<string | null>(timeline[0]?.id ?? null);

  return (
    <Card className="overflow-hidden">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <CardLabel>Health Timeline</CardLabel>
          <h3 className="mt-1 text-[15px] font-medium">Diagnostics, visits & milestones</h3>
        </div>
      </div>

      <div className="overflow-x-auto pb-2">
        <div className="relative flex min-w-max items-start gap-8 px-2">
          <motion.div
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
            style={{ transformOrigin: "left" }}
            className="absolute left-2 right-2 top-[19px] h-px bg-white/[0.08]"
          />
          {timeline.map((event, i) => {
            const meta = TYPE_META[event.type];
            const Icon = meta.icon;
            const isOpen = openId === event.id;
            return (
              <motion.button
                key={event.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.15 + i * 0.06 }}
                onClick={() => setOpenId(isOpen ? null : event.id)}
                className="relative z-10 flex w-[168px] shrink-0 flex-col items-start text-left"
              >
                <span
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-full border transition-all",
                    isOpen ? "border-transparent" : "border-hairline bg-[#151515]"
                  )}
                  style={isOpen ? { backgroundColor: meta.color + "22", boxShadow: `0 0 0 1px ${meta.color}55` } : undefined}
                >
                  <Icon size={16} style={{ color: meta.color }} />
                </span>
                <p className="mt-2.5 text-[11px] tabular-nums text-text-tertiary">
                  {formatDate(event.date)}
                </p>
                <p className="mt-0.5 text-[13px] font-medium leading-snug text-text-primary">
                  {event.title}
                </p>
              </motion.button>
            );
          })}
        </div>
      </div>

      <AnimatePresence mode="wait">
        {openId && (
          <motion.div
            key={openId}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            {(() => {
              const event = timeline.find((e) => e.id === openId)!;
              return (
                <div className="mt-5 rounded-2xl border border-hairline bg-white/[0.03] p-4">
                  <p className="text-[12px] text-text-tertiary">{event.facility}</p>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-text-secondary">
                    {event.description}
                  </p>
                </div>
              );
            })()}
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}
