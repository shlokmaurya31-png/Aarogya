"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Languages, Check } from "lucide-react";
import { useLanguageStore } from "@/store/useLanguageStore";
import { LANGUAGES } from "@/lib/i18n";

export function LanguageSwitcher() {
  const [open, setOpen] = useState(false);
  const language = useLanguageStore((s) => s.language);
  const setLanguage = useLanguageStore((s) => s.setLanguage);
  const current = LANGUAGES.find((l) => l.code === language) ?? LANGUAGES[0];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Change language"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full border border-hairline px-3 py-1.5 text-[12px] text-text-secondary transition hover:border-hairline-strong hover:text-text-primary"
      >
        <Languages size={13} />
        <span className="hidden sm:inline">{current.nativeLabel}</span>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={{ duration: 0.15 }}
              className="glass-strong card-shadow absolute right-0 top-full z-50 mt-2 max-h-80 w-52 overflow-y-auto rounded-2xl p-1.5"
            >
              {LANGUAGES.map((l) => (
                <button
                  key={l.code}
                  onClick={() => {
                    setLanguage(l.code);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-left text-[13px] text-text-secondary transition hover:bg-black/[0.04] hover:text-text-primary"
                >
                  <span className="flex items-baseline gap-1.5">
                    <span>{l.nativeLabel}</span>
                    {l.nativeLabel !== l.label && (
                      <span className="text-[11px] text-text-tertiary">{l.label}</span>
                    )}
                  </span>
                  {l.code === language && <Check size={13} className="shrink-0 text-cyan" />}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
