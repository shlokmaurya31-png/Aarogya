"use client";

import { useEffect } from "react";
import { useLanguageStore } from "@/store/useLanguageStore";

export function LanguageDirEffect() {
  const language = useLanguageStore((s) => s.language);

  useEffect(() => {
    document.documentElement.dir = language === "ur" ? "rtl" : "ltr";
    document.documentElement.lang = language;
  }, [language]);

  return null;
}
