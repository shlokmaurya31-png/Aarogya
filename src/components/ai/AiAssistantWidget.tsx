"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles, X } from "lucide-react";
import { AiAssistantPanel } from "./AiAssistantPanel";
import { useTranslation } from "@/hooks/useTranslation";

export function AiAssistantWidget() {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.97 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="card-shadow fixed bottom-24 right-5 z-50 w-[calc(100vw-2.5rem)] max-w-[380px] sm:right-6"
          >
            <AiAssistantPanel onClose={() => setOpen(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-5 right-5 z-50 flex h-[52px] w-[52px] items-center justify-center rounded-full bg-cyan text-ink shadow-lg transition hover:brightness-110 active:scale-95 sm:right-6"
        aria-label={open ? t("ai.closeAssistant") : t("ai.openAssistant")}
      >
        {open ? <X size={20} /> : <Sparkles size={20} />}
        {!open && <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-ink bg-emerald" />}
      </motion.button>
    </>
  );
}
