"use client";

import Link from "next/link";
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useSpring,
  useTransform,
} from "framer-motion";
import { ArrowRight, ChevronDown } from "lucide-react";
import { MagneticButton } from "./MagneticButton";
import { PulseWave } from "./PulseWave";
import { useLenis } from "lenis/react";

const HEADLINE_TOP = ["The", "body,"];
const HEADLINE_BOTTOM = ["finally", "legible."];

function StaggeredLine({ words, delay }: { words: string[]; delay: number }) {
  return (
    <span className="block overflow-hidden">
      {words.map((w, i) => (
        <motion.span
          key={w}
          initial={{ y: "110%" }}
          animate={{ y: 0 }}
          transition={{ duration: 0.9, delay: delay + i * 0.08, ease: [0.16, 1, 0.3, 1] }}
          className="inline-block bg-gradient-to-b from-white to-white/55 bg-clip-text pr-[0.28em] text-transparent"
        >
          {w}
        </motion.span>
      ))}
    </span>
  );
}

export function HeroSection() {
  const lenis = useLenis();
  const mx = useMotionValue(0.5);
  const my = useMotionValue(0.4);
  const lx = useTransform(useSpring(mx, { stiffness: 40, damping: 20 }), (v) => v * 100);
  const ly = useTransform(useSpring(my, { stiffness: 40, damping: 20 }), (v) => v * 100);
  const light = useMotionTemplate`radial-gradient(600px circle at ${lx}% ${ly}%, rgba(120,200,255,0.07), transparent 65%)`;

  return (
    <section
      onMouseMove={(e) => {
        mx.set(e.clientX / window.innerWidth);
        my.set(e.clientY / window.innerHeight);
      }}
      className="noise relative flex h-screen min-h-[640px] flex-col overflow-hidden"
    >
      {/* mouse-reactive holographic light */}
      <motion.div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: light }}
      />

      {/* perspective grid */}
      <div aria-hidden className="holo-grid absolute inset-0" />

      {/* holographic ECG trace */}
      <PulseWave />

      {/* headline overlay */}
      <div className="pointer-events-none relative z-10 flex flex-1 flex-col justify-center px-6 sm:px-10">
        <div className="mx-auto w-full max-w-[1400px]">
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, delay: 0.2 }}
            className="text-[12px] font-medium uppercase tracking-[0.24em] text-cyan"
          >
            Aarogya AI — India&rsquo;s health operating system
          </motion.p>

          <h1 className="mt-6 text-[clamp(3.2rem,10vw,8rem)] font-semibold leading-[0.95] tracking-tighter">
            <StaggeredLine words={HEADLINE_TOP} delay={0.35} />
            <StaggeredLine words={HEADLINE_BOTTOM} delay={0.55} />
          </h1>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.9 }}
            className="mt-7 max-w-md text-[15.5px] leading-relaxed text-text-secondary"
          >
            One permanent health record for every Indian — read by AI, verified
            by labs, understood by every doctor you will ever meet.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 1.05 }}
            className="pointer-events-auto mt-9 flex flex-wrap items-center gap-4"
          >
            <Link href="/dashboard">
              <MagneticButton className="bg-white text-ink hover:bg-cyan">
                Enter the experience <ArrowRight size={15} />
              </MagneticButton>
            </Link>
            <MagneticButton
              onClick={() => lenis?.scrollTo("#features", { offset: -60 })}
              className="border border-white/15 bg-white/[0.04] text-white backdrop-blur hover:border-cyan/40 hover:text-cyan"
            >
              Explore the platform
            </MagneticButton>
          </motion.div>
        </div>
      </div>

      {/* scroll cue */}
      <motion.button
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.6, duration: 1 }}
        onClick={() => lenis?.scrollTo("#features", { offset: -60 })}
        className="absolute bottom-7 left-1/2 z-10 -translate-x-1/2 text-text-tertiary transition hover:text-cyan"
        aria-label="Scroll to explore"
      >
        <motion.span
          animate={{ y: [0, 6, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          className="block"
        >
          <ChevronDown size={20} />
        </motion.span>
      </motion.button>

      {/* bottom fade into next section */}
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-ink to-transparent" />
    </section>
  );
}
