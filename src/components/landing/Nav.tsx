"use client";

import Link from "next/link";
import { motion, useMotionValueEvent, useScroll } from "framer-motion";
import { useState } from "react";
import { useLenis } from "lenis/react";
import { cn } from "@/lib/utils";

const LINKS = [
  { id: "features", label: "Platform" },
  { id: "timeline", label: "Timeline" },
  { id: "pricing", label: "Pricing" },
];

export function Nav() {
  const { scrollY } = useScroll();
  const [scrolled, setScrolled] = useState(false);
  const lenis = useLenis();

  useMotionValueEvent(scrollY, "change", (y) => setScrolled(y > 40));

  return (
    <motion.header
      initial={{ opacity: 0, y: -16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "fixed inset-x-0 top-0 z-50 flex items-center justify-between px-6 py-4 transition-all duration-500 sm:px-10",
        scrolled && "bg-ink/70 backdrop-blur-xl border-b border-hairline"
      )}
    >
      <button
        onClick={() => lenis?.scrollTo(0)}
        className="flex items-center gap-2.5 text-[14px] font-semibold tracking-tight"
        aria-label="Back to top"
      >
        <span className="relative flex h-2 w-2">
          <span className="absolute h-2 w-2 animate-pulse rounded-full bg-cyan" />
          <span className="h-2 w-2 rounded-full bg-cyan shadow-[0_0_12px_2px_rgba(120,200,255,0.6)]" />
        </span>
        Aarogya AI
      </button>

      <nav className="hidden items-center gap-7 md:flex">
        {LINKS.map((l) => (
          <button
            key={l.id}
            onClick={() => lenis?.scrollTo(`#${l.id}`, { offset: -60 })}
            className="text-[13px] text-text-secondary transition-colors hover:text-white"
          >
            {l.label}
          </button>
        ))}
      </nav>

      <Link
        href="/dashboard"
        className="rounded-full border border-white/15 bg-white/[0.06] px-4 py-2 text-[12.5px] font-medium text-white backdrop-blur transition hover:border-cyan/40 hover:bg-cyan/10 hover:text-cyan"
      >
        Enter Dashboard
      </Link>
    </motion.header>
  );
}
