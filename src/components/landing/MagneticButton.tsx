"use client";

import { useRef } from "react";
import { motion, useMotionValue, useSpring } from "framer-motion";
import { cn } from "@/lib/utils";

/** Button whose surface is gently pulled toward the cursor, springing back on leave. */
export function MagneticButton({
  children,
  className,
  onClick,
  href,
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  href?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 180, damping: 16 });
  const sy = useSpring(y, { stiffness: 180, damping: 16 });

  function handleMove(e: React.MouseEvent) {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    x.set((e.clientX - rect.left - rect.width / 2) * 0.25);
    y.set((e.clientY - rect.top - rect.height / 2) * 0.25);
  }

  function handleLeave() {
    x.set(0);
    y.set(0);
  }

  const inner = (
    <motion.span
      style={{ x: sx, y: sy }}
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-7 py-3.5 text-[14px] font-medium transition-colors",
        className
      )}
    >
      {children}
    </motion.span>
  );

  return (
    <div ref={ref} onMouseMove={handleMove} onMouseLeave={handleLeave} className="inline-block">
      {href ? (
        <a href={href} onClick={onClick} className="inline-block">
          {inner}
        </a>
      ) : (
        <button onClick={onClick} className="inline-block">
          {inner}
        </button>
      )}
    </div>
  );
}
