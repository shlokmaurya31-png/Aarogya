"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search } from "lucide-react";
import { patient, doctorProfile } from "@/lib/mock-data";
import { useUiStore } from "@/store/useUiStore";
import { useTranslation } from "@/hooks/useTranslation";
import { ModeToggle } from "./ModeToggle";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { cn } from "@/lib/utils";
import type { NavId, PatientNavId } from "@/types";

const DOCTOR_TABS: { id: NavId; labelKey: string }[] = [
  { id: "overview", labelKey: "nav.summary" },
  { id: "history", labelKey: "nav.history" },
  { id: "labs", labelKey: "nav.labs" },
  { id: "reports", labelKey: "nav.reports" },
  { id: "prescriptions", labelKey: "nav.prescriptions" },
  { id: "appointments", labelKey: "nav.appointments" },
  { id: "insurance", labelKey: "nav.insurance" },
  { id: "emergency", labelKey: "nav.emergency" },
];

const PATIENT_TABS: { id: PatientNavId; labelKey: string }[] = [
  { id: "home", labelKey: "nav.home" },
  { id: "appointments", labelKey: "nav.appointments" },
  { id: "medicines", labelKey: "nav.medicines" },
  { id: "reports", labelKey: "nav.reports" },
  { id: "emergency", labelKey: "nav.emergency" },
];

function Tab({
  label,
  isActive,
  onClick,
}: {
  label: string;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "relative whitespace-nowrap rounded-full px-3.5 py-1.5 text-[12.5px] transition-colors duration-200",
        isActive ? "text-text-primary" : "text-text-tertiary hover:text-text-secondary"
      )}
    >
      {isActive && (
        <motion.span
          layoutId="topbar-tab"
          className="absolute inset-0 rounded-full border border-cyan/25 bg-cyan/10"
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        />
      )}
      <span className="relative z-10">{label}</span>
    </button>
  );
}

export function TopBar() {
  const mode = useUiStore((s) => s.mode);
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const activePatientView = useUiStore((s) => s.activePatientView);
  const setActivePatientView = useUiStore((s) => s.setActivePatientView);
  const { t } = useTranslation();

  const isDoctor = mode === "doctor";
  const tabs = isDoctor ? DOCTOR_TABS : PATIENT_TABS;

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
      if (e.key === "Escape") setSearchOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (searchOpen) {
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [searchOpen]);

  const results = query.trim()
    ? tabs.filter((tab) => t(tab.labelKey).toLowerCase().includes(query.trim().toLowerCase()))
    : tabs;

  function selectResult(id: string) {
    if (isDoctor) setActiveView(id as NavId);
    else setActivePatientView(id as PatientNavId);
    setSearchOpen(false);
  }

  return (
    <>
    <header className="sticky top-0 z-40 border-b border-hairline bg-ink/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1500px] items-center gap-4 px-5 py-3">
        {/* brand */}
        <Link href="/" className="flex shrink-0 items-center gap-2 text-[13.5px] font-semibold">
          <span className="h-2 w-2 rounded-full bg-cyan shadow-[0_0_10px_2px_rgba(120,200,255,0.5)]" />
          <span className="hidden sm:inline">Aarogya</span>
        </Link>

        {/* tabs */}
        <nav className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {isDoctor
            ? DOCTOR_TABS.map((tab) => (
                <Tab
                  key={tab.id}
                  label={t(tab.labelKey)}
                  isActive={activeView === tab.id}
                  onClick={() => setActiveView(tab.id)}
                />
              ))
            : PATIENT_TABS.map((tab) => (
                <Tab
                  key={tab.id}
                  label={t(tab.labelKey)}
                  isActive={activePatientView === tab.id}
                  onClick={() => setActivePatientView(tab.id)}
                />
              ))}
        </nav>

        {/* right cluster */}
        <div className="flex shrink-0 items-center gap-3">
          <button
            onClick={() => setSearchOpen(true)}
            className="hidden items-center gap-2 rounded-full border border-hairline px-3 py-1.5 text-[12px] text-text-tertiary transition hover:border-hairline-strong hover:text-text-secondary lg:flex"
            aria-label="Search"
          >
            <Search size={13} />
            {t("topbar.search")}
            <kbd className="rounded-md border border-hairline px-1.5 font-mono text-[10px]">⌘K</kbd>
          </button>

          <LanguageSwitcher />

          <ModeToggle />

          <div className="flex items-center gap-2.5">
            <div className="hidden text-right md:block">
              <p className="text-[12px] font-medium leading-tight text-text-primary">
                {isDoctor ? doctorProfile.name : patient.name}
              </p>
              <p className="text-[10.5px] leading-tight text-text-tertiary">
                {isDoctor ? doctorProfile.specialty : patient.patientId}
              </p>
            </div>
            <div className="relative flex h-8 w-8 items-center justify-center rounded-full bg-cyan/12 text-[11px] font-semibold text-cyan">
              {isDoctor ? doctorProfile.avatarInitials : patient.avatarInitials}
              <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-ink bg-cyan" />
            </div>
          </div>
        </div>
      </div>

      {/* doctor context strip */}
      {isDoctor && (
        <div className="border-t border-hairline bg-surface/60">
          <div className="mx-auto flex max-w-[1500px] items-center gap-3 px-5 py-2 text-[11.5px]">
            <span className="text-text-tertiary">{t("topbar.viewingChart")}</span>
            <span className="font-medium text-text-primary">{patient.name}</span>
            <span className="tabular-nums text-text-tertiary">{patient.patientId}</span>
            <span className="ml-auto hidden items-center gap-1.5 text-text-tertiary sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald" />
              {t("topbar.consentActive")}
            </span>
          </div>
        </div>
      )}
    </header>

    <AnimatePresence>
      {searchOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100] flex items-start justify-center bg-black/20 pt-[15vh]"
          onClick={() => setSearchOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="glass-strong card-shadow w-full max-w-md overflow-hidden rounded-[20px]"
          >
            <div className="flex items-center gap-2.5 border-b border-hairline px-4 py-3">
              <Search size={14} className="text-text-tertiary" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Jump to a section…"
                className="flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-text-tertiary"
              />
              <kbd className="rounded-md border border-hairline px-1.5 font-mono text-[10px] text-text-tertiary">
                Esc
              </kbd>
            </div>
            <div className="max-h-72 overflow-y-auto p-1.5">
              {results.length === 0 && (
                <p className="px-3 py-4 text-center text-[12.5px] text-text-tertiary">No matches</p>
              )}
              {results.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => selectResult(tab.id)}
                  className="flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-[13px] text-text-secondary transition hover:bg-black/[0.04] hover:text-text-primary"
                >
                  {t(tab.labelKey)}
                </button>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </>
  );
}
