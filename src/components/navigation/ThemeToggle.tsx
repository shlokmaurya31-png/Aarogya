"use client";

import { Moon, Sun } from "lucide-react";
import { useThemeStore } from "@/store/useThemeStore";
import { useTranslation } from "@/hooks/useTranslation";

export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const isDark = theme === "dark";
  const { t } = useTranslation();

  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? t("theme.switchToLight") : t("theme.switchToDark")}
      className="flex items-center gap-1.5 rounded-full border border-hairline px-3 py-1.5 text-[12px] text-text-secondary transition hover:border-hairline-strong hover:text-text-primary"
    >
      {isDark ? <Sun size={13} /> : <Moon size={13} />}
    </button>
  );
}
