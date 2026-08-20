"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "@/hooks/useTranslation";
import type { AuthUser } from "@/types";

export function DashboardHero({ user, pendingCount }: { user: AuthUser; pendingCount: number }) {
  const { t } = useTranslation();
  const isAdmin = user.role === "admin";

  return (
    <div className="relative overflow-hidden rounded-lg border border-hairline bg-card">
      <div
        className="pointer-events-none absolute -top-20 left-1/2 h-56 w-[70%] -translate-x-1/2 rounded-full bg-cyan/20 blur-[70px]"
        aria-hidden="true"
      />
      <div className="relative z-10 flex flex-col gap-6 px-6 py-7 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.14em] text-text-tertiary">
            {isAdmin ? t("admin.hero.eyebrowAdmin") : t("admin.hero.eyebrowStaff")}
          </p>
          <h1 className="mt-2 text-[24px] font-semibold tracking-tight text-text-primary sm:text-[26px]">
            {t("admin.hero.greeting")}, {user.name}
          </h1>
          <p className="mt-2 max-w-md text-[13px] leading-relaxed text-text-secondary">
            {isAdmin ? t("admin.hero.subtitleAdmin") : t("admin.hero.subtitleStaff")}
            {pendingCount > 0 && (
              <>
                {" "}
                <span className="font-medium text-amber">
                  {pendingCount} {t("admin.hero.pendingSuffix")}
                </span>
              </>
            )}
          </p>
          <Link
            href="/admin/verifications"
            className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-cyan px-4 py-2.5 text-[12.5px] font-medium text-ink transition hover:brightness-110 active:scale-[0.98]"
          >
            {t("admin.hero.cta")} <ArrowRight size={14} />
          </Link>
        </div>
        <img
          src="https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?auto=format&fit=crop&w=480&q=80"
          alt=""
          aria-hidden="true"
          className="hidden h-32 w-48 shrink-0 rounded-lg object-cover shadow-lg sm:block"
        />
      </div>
    </div>
  );
}
