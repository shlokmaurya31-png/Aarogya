"use client";

import { useLanguageStore } from "@/store/useLanguageStore";
import { translateShell } from "@/lib/i18nShell";

/** Flagship 5 (6a): the shell's strings only (src/lib/i18nShell.ts), so a page's shell never pulls in the full dictionary. */
export function useShellTranslation() {
  const language = useLanguageStore((s) => s.language);
  return { t: (key: string) => translateShell(key, language), language };
}
