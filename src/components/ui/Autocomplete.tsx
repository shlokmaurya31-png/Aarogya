"use client";

import { useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";

export function Autocomplete({
  value,
  onChange,
  options,
  placeholder,
  className,
  maxResults = 8,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder?: string;
  className?: string;
  maxResults?: number;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const query = value.trim().toLowerCase();
    if (!query) return [];
    return options.filter((o) => o.toLowerCase().includes(query)).slice(0, maxResults);
  }, [value, options, maxResults]);

  function select(option: string) {
    onChange(option);
    setOpen(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || matches.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((i) => (i + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      select(matches[highlighted]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setHighlighted(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        className={className}
      />

      <AnimatePresence>
        {open && matches.length > 0 && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.15 }}
              className="glass-strong card-shadow absolute left-0 right-0 top-full z-50 mt-1.5 max-h-52 overflow-y-auto rounded-2xl p-1.5"
            >
              {matches.map((option, i) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => select(option)}
                  onMouseEnter={() => setHighlighted(i)}
                  className={cn(
                    "block w-full truncate rounded-xl px-3 py-2 text-left text-[13px] transition",
                    i === highlighted ? "bg-cyan/10 text-cyan" : "text-text-secondary hover:bg-black/[0.04]"
                  )}
                >
                  {option}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
