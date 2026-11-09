import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LanguageCode } from "@/lib/i18nShell";

interface LanguageState {
  language: LanguageCode;
  setLanguage: (language: LanguageCode) => void;
}

export const useLanguageStore = create<LanguageState>()(
  persist(
    (set) => ({
      language: "en",
      setLanguage: (language) => set({ language }),
    }),
    { name: "aarogya-language" }
  )
);
