"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

const MESSAGES = [
  "Initializing AI Engine",
  "Connecting Hospitals",
  "Loading Health Records",
  "Verifying Encryption",
  "Connecting National Health Grid",
  "Preparing Dashboard",
];

const STEP_MS = 420;

interface Particle {
  id: number;
  x: number;
  y: number;
  size: number;
  delay: number;
  duration: number;
}

function generateParticles(): Particle[] {
  return Array.from({ length: 28 }, (_, i) => ({
    id: i,
    x: Math.random() * 100,
    y: Math.random() * 100,
    size: Math.random() * 2 + 0.6,
    delay: Math.random() * 2,
    duration: Math.random() * 6 + 8,
  }));
}

export function LoadingScreen({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const [particles, setParticles] = useState<Particle[]>([]);

  useEffect(() => {
    // One-time client-only randomization, deliberately skipped on the server
    // render so particle positions never mismatch during hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setParticles(generateParticles());
  }, []);

  useEffect(() => {
    if (step >= MESSAGES.length - 1) {
      const t = setTimeout(() => setLeaving(true), STEP_MS + 260);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStep((s) => s + 1), STEP_MS);
    return () => clearTimeout(t);
  }, [step]);

  useEffect(() => {
    if (leaving) {
      const t = setTimeout(onComplete, 550);
      return () => clearTimeout(t);
    }
  }, [leaving, onComplete]);

  const progress = ((step + 1) / MESSAGES.length) * 100;

  return (
    <AnimatePresence>
      {!leaving && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-ink overflow-hidden"
          exit={{ opacity: 0, filter: "blur(12px)" }}
          transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
        >
          {/* radial glow */}
          <div
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(circle at 50% 45%, rgba(120,200,255,0.08) 0%, rgba(8,8,8,0) 60%)",
            }}
          />

          {/* particles */}
          {particles.map((p) => (
            <motion.span
              key={p.id}
              className="absolute rounded-full bg-black/15"
              style={{
                left: `${p.x}%`,
                top: `${p.y}%`,
                width: p.size,
                height: p.size,
              }}
              animate={{
                y: [0, -18, 0],
                opacity: [0.15, 0.5, 0.15],
              }}
              transition={{
                duration: p.duration,
                delay: p.delay,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
          ))}

          <div className="relative flex flex-col items-center gap-8">
            {/* logo + heartbeat */}
            <div className="flex flex-col items-center gap-5">
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
                className="flex items-center gap-3"
              >
                <span className="h-2 w-2 rounded-full bg-cyan shadow-[0_0_18px_2px_rgba(120,200,255,0.7)]" />
                <span className="text-[15px] tracking-[0.28em] text-text-secondary uppercase">
                  Aarogya AI
                </span>
              </motion.div>

              <svg width="220" height="46" viewBox="0 0 220 46" fill="none">
                <motion.path
                  d="M0 23 H70 L82 4 L96 42 L108 12 L118 30 L128 23 H220"
                  stroke="var(--cyan)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                  initial={{ pathLength: 0, opacity: 0.3 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ duration: 1.6, ease: "easeInOut", repeat: Infinity }}
                />
              </svg>
            </div>

            {/* status text */}
            <div className="h-5 flex items-center justify-center">
              <AnimatePresence mode="wait">
                <motion.p
                  key={step}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.3, ease: "easeOut" }}
                  className="text-[13px] text-text-tertiary tracking-wide"
                >
                  {MESSAGES[step]}
                  <span className="animate-pulse">…</span>
                </motion.p>
              </AnimatePresence>
            </div>

            {/* progress line */}
            <div className="w-[220px] h-px bg-black/[0.08] overflow-hidden rounded-full">
              <motion.div
                className="h-full bg-gradient-to-r from-cyan/40 via-cyan to-cyan/40"
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.4, ease: "easeOut" }}
              />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
