"use client";

import { useEffect } from "react";
import { useThemeStore } from "@/store/useThemeStore";

export function ThemeInit() {
  useEffect(() => {
    const stored = window.localStorage.getItem("aarogya-theme");
    if (stored) return;
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    useThemeStore.getState().setTheme(prefersDark ? "dark" : "light");
  }, []);

  return null;
}
