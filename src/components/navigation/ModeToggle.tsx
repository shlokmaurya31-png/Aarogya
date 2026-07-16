"use client";

import { motion } from "framer-motion";
import { User, Stethoscope } from "lucide-react";
import { useUiStore } from "@/store/useUiStore";
import { cn } from "@/lib/utils";
import type { UserMode } from "@/types";

const OPTIONS: { id: UserMode; label: string; icon: typeof User }[] = [
  { id: "patient", label: "Patient", icon: User },
  { id: "doctor", label: "Doctor", icon: Stethoscope },
];

export function ModeToggle() {
  const mode = useUiStore((s) => s.mode);
  const setMode = useUiStore((s) => s.setMode);

  return (
    <div className="flex rounded-full border border-hairline bg-white/[0.03] p-0.5">
      {OPTIONS.map((o) => {
        const Icon = o.icon;
        const active = mode === o.id;
        return (
          <button
            key={o.id}
            onClick={() => setMode(o.id)}
            aria-pressed={active}
            className={cn(
              "relative flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11.5px] font-medium transition-colors",
              active ? "text-ink" : "text-text-tertiary hover:text-text-secondary"
            )}
          >
            {active && (
              <motion.span
                layoutId="mode-toggle-active"
                className="absolute inset-0 rounded-full bg-cyan"
                transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              />
            )}
            <Icon size={12} className="relative z-10" />
            <span className="relative z-10 hidden sm:inline">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
