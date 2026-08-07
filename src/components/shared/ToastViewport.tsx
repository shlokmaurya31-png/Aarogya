"use client";

import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, TriangleAlert, XCircle, Info, X } from "lucide-react";
import { useToastStore, type ToastTone } from "@/store/useToastStore";
import { useTranslation } from "@/hooks/useTranslation";

const TONE_ICON: Record<ToastTone, typeof CheckCircle2> = {
  emerald: CheckCircle2,
  amber: TriangleAlert,
  red: XCircle,
  cyan: Info,
};

const TONE_COLOR: Record<ToastTone, string> = {
  emerald: "var(--emerald)",
  amber: "var(--amber)",
  red: "var(--red)",
  cyan: "var(--cyan)",
};

export function ToastViewport() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const { t } = useTranslation();

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[200] flex flex-col items-center gap-2 px-4">
      <AnimatePresence>
        {toasts.map((toast) => {
          const Icon = TONE_ICON[toast.tone];
          const color = TONE_COLOR[toast.tone];
          return (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.96 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
              className="glass-strong card-shadow pointer-events-auto flex w-full max-w-sm items-center gap-2.5 rounded-full px-4 py-2.5"
            >
              <Icon size={16} className="shrink-0" style={{ color }} />
              <p className="flex-1 text-[12.5px] font-medium text-text-primary">{toast.message}</p>
              <button
                onClick={() => dismiss(toast.id)}
                aria-label={t("common.dismiss")}
                className="shrink-0 text-text-tertiary transition hover:text-text-secondary"
              >
                <X size={13} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
