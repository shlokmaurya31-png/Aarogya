"use client";

import { useLanguageStore } from "@/store/useLanguageStore";
import { translate } from "@/lib/i18n";

export function useTranslation() {
  const language = useLanguageStore((s) => s.language);
  return { t: (key: string) => translate(key, language), language };
}
