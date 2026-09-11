"use client";

import { Moon, Sun } from "lucide-react";
import { useThemeStore } from "@/store/useThemeStore";
import { useTranslation } from "@/hooks/useTranslation";

/**
 * Light/dark theme toggle.
 *
 * Two variants because the shells differ in shape, not behaviour:
 *   "icon"    — compact pill for top bars (the original form)
 *   "sidebar" — full-width labelled row for sidebar footers, matching the
 *               Sign-out row it sits beside
 *
 * Persistence and first-paint are handled elsewhere: the blocking script in
 * app/layout.tsx applies the stored `data-theme` before render, so switching
 * here survives a reload with no flash of the wrong theme.
 */
export function ThemeToggle({
  variant = "icon",
  className = "",
}: {
  variant?: "icon" | "sidebar";
  className?: string;
}) {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const isDark = theme === "dark";
  const { t } = useTranslation();

  const label = isDark ? t("theme.switchToLight") : t("theme.switchToDark");
  const Icon = isDark ? Sun : Moon;

  if (variant === "sidebar") {
    return (
      <button
        onClick={() => setTheme(isDark ? "light" : "dark")}
        aria-label={label}
        title={label}
        className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[12.5px] text-text-secondary transition hover:bg-black/[0.03] hover:text-text-primary ${className}`}
      >
        <Icon size={14} />
        {isDark ? t("settings.theme.light") : t("settings.theme.dark")}
      </button>
    );
  }

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={label}
      title={label}
      className={`flex items-center gap-1.5 rounded-full border border-hairline px-3 py-1.5 text-[12px] text-text-secondary transition hover:border-hairline-strong hover:text-text-primary ${className}`}
    >
      <Icon size={13} />
    </button>
  );
}
