"use client";

import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";

export const hospitalInputClass =
  "w-full rounded-xl border border-hairline bg-black/[0.025] px-3.5 py-2.5 text-[13px] outline-none focus:border-cyan/40";

export function FormModal({
  open,
  title,
  onClose,
  onSubmit,
  submitLabel,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  onSubmit: () => void;
  submitLabel: string;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/20 px-4 py-[8vh]"
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="glass-strong card-shadow w-full max-w-md rounded-[20px]"
          >
            <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
              <p className="text-[14px] font-semibold text-text-primary">{title}</p>
              <button
                onClick={onClose}
                aria-label="Close"
                className="text-text-tertiary transition hover:text-text-secondary"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">{children}</div>

            <div className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-4">
              <button
                onClick={onClose}
                className="rounded-full border border-hairline px-4 py-2 text-[12.5px] font-medium text-text-secondary transition hover:border-hairline-strong"
              >
                {t("btn.cancel")}
              </button>
              <button
                onClick={onSubmit}
                className="rounded-full bg-cyan px-4 py-2 text-[12.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.97]"
              >
                {submitLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
