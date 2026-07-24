"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { useLenis } from "lenis/react";

const HEADLINE_TOP = ["the", "body,"];
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
          className="inline-block bg-gradient-to-b from-text-primary to-text-primary/55 bg-clip-text pr-[0.28em] text-transparent"
        >
          {w}
        </motion.span>
      ))}
    </span>
  );
}

const VIDEO_SRC =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260601_110537_3a579fa0-7bbc-4d94-9d25-0e816c7840f5.mp4";

function BackgroundVideo() {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Desktop mouse scrubbing
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let prevX: number | null = null;
    let targetTime: number | null = null;
    let seeking = false;

    function handleSeeked() {
      seeking = false;
    }

    function handleMouseMove(e: MouseEvent) {
      if (!video || window.innerWidth < 1024) return;
      if (!video.duration || Number.isNaN(video.duration)) return;

      if (prevX === null) {
        prevX = e.clientX;
        targetTime = video.currentTime;
        return;
      }

      const deltaX = e.clientX - prevX;
      prevX = e.clientX;
      targetTime = (targetTime ?? video.currentTime) + (deltaX / window.innerWidth) * 0.8 * video.duration;
      targetTime = Math.max(0, Math.min(video.duration, targetTime));

      if (!seeking) {
        seeking = true;
        video.currentTime = targetTime;
      }
    }

    video.addEventListener("seeked", handleSeeked);
    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      video.removeEventListener("seeked", handleSeeked);
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, []);

  // Mobile autoplay (scrubbing is desktop-only)
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (window.innerWidth < 1024) {
      video.autoplay = true;
      video.play().catch(() => {});
    }
  }, []);

  return (
    <div className="order-last lg:order-none relative lg:absolute lg:inset-0 lg:z-0 overflow-hidden pointer-events-none w-full aspect-square md:aspect-video lg:aspect-auto lg:h-full bg-neutral-50 lg:bg-transparent">
      <video
        ref={videoRef}
        muted
        playsInline
        preload="auto"
        src={VIDEO_SRC}
        className="w-full h-full object-cover object-right lg:object-right-bottom"
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 hidden lg:block bg-gradient-to-r from-ink via-ink/70 to-transparent" />
    </div>
  );
}

function HeroNav() {
  const lenis = useLenis();

  return (
    <header className="fixed top-0 inset-x-0 z-20 px-5 sm:px-8 py-4 sm:py-5 flex flex-row justify-between items-center bg-transparent">
      <button
        onClick={() => lenis?.scrollTo(0)}
        className="flex items-center gap-2.5 text-[14px] font-semibold tracking-tight"
        aria-label="Back to top"
      >
        <span className="text-text-primary">Aarogya</span>
        <span className="text-emerald select-none">&#10010;</span>
      </button>

      <Link
        href="/dashboard"
        className="rounded-full border border-black/10 bg-black/[0.05] px-4 py-2 text-[12.5px] font-medium text-text-primary backdrop-blur transition hover:border-cyan/40 hover:bg-cyan/10 hover:text-cyan"
      >
        Enter Dashboard
      </Link>
    </header>
  );
}

export function Hero() {
  return (
    <div className="relative bg-ink text-text-primary font-sans selection:bg-emerald/15 selection:text-emerald antialiased overflow-x-hidden flex flex-col lg:block lg:min-h-screen">
      <HeroNav />

      <BackgroundVideo />

      <div className="relative z-10 flex flex-col order-first lg:order-none w-full bg-ink lg:bg-transparent pb-8 lg:pb-0 lg:min-h-screen">
        <main id="aarogya-hero" className="w-full max-w-7xl mx-auto px-6 py-12 flex-1 flex flex-col justify-center">
          <h1 className="text-5xl md:text-6xl lg:text-[76px] font-normal tracking-tight leading-[1.08] mb-8 select-none w-full">
            <StaggeredLine words={HEADLINE_TOP} delay={0.35} />
            <StaggeredLine words={HEADLINE_BOTTOM} delay={0.55} />
          </h1>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.7 }}
          >
            <p className="text-lg md:text-xl text-text-secondary leading-relaxed font-normal mb-14 max-w-2xl">
              One permanent health record for every Indian — <br />
              read by AI, verified by labs, understood by every doctor you will ever meet.
            </p>
          </motion.div>
        </main>
      </div>
    </div>
  );
}
