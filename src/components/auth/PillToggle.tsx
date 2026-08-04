"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export function PillToggle<T extends string>({
  groupId,
  options,
  value,
  onChange,
}: {
  groupId: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="inline-flex rounded-full border border-hairline bg-black/[0.025] p-1">
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          onClick={() => onChange(opt.id)}
          className={cn(
            "relative rounded-full px-4 py-1.5 text-[12.5px] font-medium transition-colors",
            value === opt.id ? "text-ink" : "text-text-secondary hover:text-text-primary"
          )}
        >
          {value === opt.id && (
            <motion.span
              layoutId={`pill-toggle-${groupId}`}
              className="absolute inset-0 rounded-full bg-cyan"
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            />
          )}
          <span className="relative z-10">{opt.label}</span>
        </button>
      ))}
    </div>
  );
}
