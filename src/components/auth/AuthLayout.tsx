"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { useTranslation } from "@/hooks/useTranslation";

export function AuthLayout({
  eyebrow,
  title,
  subtitle,
  children,
  footer,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative min-h-screen bg-ink text-text-primary lg:grid lg:grid-cols-2">
      <div className="holo-grid noise relative hidden overflow-hidden border-r border-hairline bg-surface lg:flex lg:flex-col lg:justify-between lg:p-10">
        <Link href="/" className="flex items-center gap-2.5 text-[14px] font-semibold">
          <span className="h-2 w-2 rounded-full bg-cyan shadow-[0_0_10px_2px_rgba(120,200,255,0.5)]" />
          Aarogya
        </Link>
        <div className="max-w-sm">
          <p className="text-[28px] font-semibold leading-[1.15] tracking-tight">
            {t("auth.layout.tagline")}
          </p>
          <p className="mt-4 text-[13.5px] leading-relaxed text-text-secondary">
            {t("auth.layout.taglineSub")}
          </p>
        </div>
        <p className="text-[11.5px] text-text-tertiary">{t("auth.layout.copyright")}</p>
      </div>

      <div className="flex min-h-screen flex-col justify-center px-6 py-12 sm:px-12 lg:px-16">
        <Link href="/" className="mb-10 flex items-center gap-2.5 text-[14px] font-semibold lg:hidden">
          <span className="h-2 w-2 rounded-full bg-cyan shadow-[0_0_10px_2px_rgba(120,200,255,0.5)]" />
          Aarogya
        </Link>

        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="mx-auto w-full max-w-[400px]"
        >
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-cyan">{eyebrow}</p>
          <h1 className="mt-2 text-[26px] font-semibold tracking-tight">{title}</h1>
          <p className="mt-1.5 text-[13.5px] text-text-secondary">{subtitle}</p>

          <div className="mt-8">{children}</div>

          {footer && <div className="mt-6">{footer}</div>}
        </motion.div>
      </div>
    </div>
  );
}
