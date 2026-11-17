"use client";

import { CheckCircle2, TriangleAlert, XCircle, Info, X } from "lucide-react";
import { useToastStore, type ToastTone } from "@/store/useToastStore";
import { useShellTranslation } from "@/hooks/useShellTranslation";

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
  const { t } = useShellTranslation();

  return (
    // Flagship 5 (6a/6b): a CSS entrance instead of framer-motion (every page loaded it for this), and announced to screen readers.
    <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-5 z-[200] flex flex-col items-center gap-2 px-4">
        {toasts.map((toast) => {
          const Icon = TONE_ICON[toast.tone];
          const color = TONE_COLOR[toast.tone];
          return (
            <div
              key={toast.id}
              className="aarogya-pop glass-strong card-shadow pointer-events-auto flex w-full max-w-sm items-center gap-2.5 rounded-full px-4 py-2.5"
            >
              <Icon size={16} aria-hidden className="shrink-0" style={{ color }} />
              <p className="flex-1 text-[12.5px] font-medium text-text-primary">{toast.message}</p>
              <button
                onClick={() => dismiss(toast.id)}
                aria-label={t("common.dismiss")}
                className="shrink-0 text-text-tertiary transition hover:text-text-secondary"
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
    </div>
  );
}
