"use client";

import Link from "next/link";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  LogOut, Home, CalendarDays, FileText, Pill, Receipt,
  ShieldCheck, Users, User as UserIcon, ClipboardList, ListChecks, KeyRound,
} from "lucide-react";
import { Sparkles, FolderUp, Stethoscope } from "lucide-react";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { ThemeToggle } from "@/components/navigation/ThemeToggle";
import { AiAssistantProvider, AiCommandBar } from "@/components/ai/PortalAssistant";
import { clearAppData } from "@/lib/pwa/clearCaches";
import { LANGUAGES, type LanguageCode } from "@/lib/i18nShell";
import { useShellTranslation } from "@/hooks/useShellTranslation";
import { useLanguageStore } from "@/store/useLanguageStore";

/**
 * Phase D11 — the patient experience shell. A simple, single navigation model
 * (brief §32) — no internal hospital jargon, no dead-end links. Same tokens as
 * the rest of Aarogya so the portal reads as one product.
 *
 * Flagship 5 (6b): the shell speaks the person's app language: the page's
 * lang and direction (Urdu right to left), the navigation, sign-out, the
 * language picker and the skip link. A screen whose text isn't translated
 * yet is marked as English (lang="en", left to right) so a screen reader
 * pronounces it correctly (docs/MOBILE_ACCESSIBILITY.md §3).
 */
const NAV = [
  { href: "/patient", label: "patient.nav.home", icon: Home },
  { href: "/patient/appointments", label: "patient.nav.appointments", icon: CalendarDays },
  { href: "/patient/doctors", label: "patient.nav.doctors", icon: Stethoscope },
  { href: "/patient/household", label: "patient.nav.household", icon: Users },
  { href: "/patient/queue", label: "patient.nav.queue", icon: ListChecks },
  { href: "/patient/share", label: "patient.nav.share", icon: KeyRound },
  { href: "/patient/records", label: "patient.nav.records", icon: ClipboardList },
  { href: "/patient/reports", label: "patient.nav.reports", icon: FileText },
  { href: "/patient/documents", label: "patient.nav.documents", icon: FolderUp },
  { href: "/patient/medications", label: "patient.nav.medications", icon: Pill },
  { href: "/patient/billing", label: "patient.nav.billing", icon: Receipt },
  { href: "/patient/insurance", label: "patient.nav.insurance", icon: ShieldCheck },
  { href: "/patient/consent", label: "patient.nav.consent", icon: ShieldCheck },
  { href: "/patient/family", label: "patient.nav.family", icon: Users },
  { href: "/patient/profile", label: "patient.nav.profile", icon: UserIcon },
];

export function PatientShell({ children, displayName }: { children: React.ReactNode; displayName: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const { t, language } = useShellTranslation();
  const setLanguage = useLanguageStore((s) => s.setLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ur" ? "rtl" : "ltr";
    return () => { document.documentElement.lang = "en"; document.documentElement.dir = "ltr"; };
  }, [language]);

  async function handleLogout() {
    await fetch("/api/scholar-auth/logout", { method: "POST" });
    await clearAppData();
    router.push("/patient/login");
    router.refresh();
  }

  const isActive = (href: string) => (href === "/patient" ? pathname === "/patient" : pathname.startsWith(href));

  return (
    <AiAssistantProvider role="PATIENT" displayName={displayName}>
    <div className="min-h-screen bg-surface text-text-primary">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-[13px]">{t("patient.skip")}</a>
      <ToastViewport />
      <header className="sticky top-0 z-40 border-b border-hairline bg-card px-4 py-3.5">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-2">
          <Link href="/patient" className="flex shrink-0 items-center gap-2 text-[14px] font-semibold">
            <span className="flex size-6 items-center justify-center rounded-md bg-gradient-to-br from-cyan to-brand-strong text-on-brand">
              <Sparkles size={13} />
            </span>
            Aarogya AI
          </Link>
          <AiCommandBar className="mx-auto max-w-xs flex-1 justify-start" />
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden text-[12px] text-text-secondary sm:inline">{displayName}</span>
            <select aria-label={t("patient.language")} value={language} onChange={(e) => setLanguage(e.target.value as LanguageCode)} className="min-h-[36px] rounded-md border border-hairline bg-card px-1.5 text-[12px] text-text-secondary">
              {LANGUAGES.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.nativeLabel}</option>)}
            </select>
            <ThemeToggle />
            <button onClick={handleLogout} className="flex min-h-[36px] items-center gap-1.5 rounded-md border border-hairline px-3 py-1.5 text-[12px] text-text-secondary hover:border-red/30 hover:text-red">
              <LogOut size={13} aria-hidden /> {t("patient.signOut")}
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-5xl gap-6 px-4 py-6">
        <nav aria-label={t("patient.nav.label")} className="hidden w-44 shrink-0 flex-col gap-0.5 sm:flex">
          {NAV.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] ${
                  active ? "bg-cyan/10 font-medium text-cyan" : "text-text-secondary hover:bg-card-raised hover:text-text-primary"
                }`}
              >
                <Icon size={15} aria-hidden /> {t(item.label)}
              </Link>
            );
          })}
        </nav>
        {/* The screens' own text is English until translated: marked so (lang, direction) for screen readers. */}
        <main id="main" tabIndex={-1} lang="en" dir="ltr" className="min-w-0 flex-1 outline-none">{children}</main>
      </div>

      {/* Mobile: horizontal scrollable nav at the bottom. */}
      <nav aria-label={t("patient.nav.label")} className="sticky bottom-0 z-40 flex gap-1 overflow-x-auto border-t border-hairline bg-card px-2 py-1.5 sm:hidden">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link key={item.href} href={item.href} className={`flex shrink-0 flex-col items-center gap-0.5 rounded-md px-3 py-1 text-[10px] ${active ? "text-cyan" : "text-text-secondary"}`}>
              <Icon size={16} aria-hidden /> {t(item.label)}
            </Link>
          );
        })}
      </nav>
    </div>
    </AiAssistantProvider>
  );
}
