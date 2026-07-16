"use client";

import { motion } from "framer-motion";

/**
 * A wide holographic ECG trace that draws itself across the hero, then
 * loops a slow pulse of light along the line. Pure SVG — no WebGL cost.
 */
const TRACE =
  "M0 90 H240 L268 90 L282 52 L298 128 L314 30 L330 132 L348 76 L362 90 H560 L586 90 L600 62 L614 116 L630 42 L646 124 L664 82 L678 90 H940 L966 90 L980 56 L994 122 L1010 36 L1026 128 L1044 78 L1058 90 H1440";

export function PulseWave() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2">
      <svg
        viewBox="0 0 1440 180"
        preserveAspectRatio="none"
        className="h-[180px] w-full opacity-70"
        fill="none"
      >
        {/* soft under-glow */}
        <motion.path
          d={TRACE}
          stroke="rgba(120,200,255,0.16)"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 2.4, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
          style={{ filter: "blur(6px)" }}
        />
        {/* crisp trace */}
        <motion.path
          d={TRACE}
          stroke="rgba(120,200,255,0.55)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 2.4, delay: 0.5, ease: [0.16, 1, 0.3, 1] }}
        />
        {/* travelling light pulse */}
        <motion.path
          d={TRACE}
          stroke="#c9e8ff"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0.06, pathOffset: 0, opacity: 0 }}
          animate={{ pathOffset: [0, 0.94], opacity: [0, 1, 1, 0] }}
          transition={{ duration: 3.6, delay: 3, repeat: Infinity, repeatDelay: 1.2, ease: "linear" }}
          style={{ filter: "drop-shadow(0 0 6px rgba(120,200,255,0.9))" }}
        />
      </svg>
    </div>
  );
}
