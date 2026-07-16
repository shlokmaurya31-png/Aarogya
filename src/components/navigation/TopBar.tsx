"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Search } from "lucide-react";
import { patient, doctorProfile } from "@/lib/mock-data";
import { useUiStore } from "@/store/useUiStore";
import { ModeToggle } from "./ModeToggle";
import { cn } from "@/lib/utils";
import type { NavId, PatientNavId } from "@/types";

const DOCTOR_TABS: { id: NavId; label: string }[] = [
  { id: "overview", label: "Summary" },
  { id: "history", label: "History" },
  { id: "labs", label: "Labs" },
  { id: "reports", label: "Reports" },
  { id: "prescriptions", label: "Meds" },
  { id: "appointments", label: "Appointments" },
  { id: "insurance", label: "Insurance" },
  { id: "emergency", label: "Emergency" },
];

const PATIENT_TABS: { id: PatientNavId; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "appointments", label: "Appointments" },
  { id: "medicines", label: "Medicines" },
  { id: "reports", label: "Reports" },
  { id: "emergency", label: "Emergency" },
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
        isActive ? "text-white" : "text-text-tertiary hover:text-text-secondary"
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

  const isDoctor = mode === "doctor";

  return (
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
            ? DOCTOR_TABS.map((t) => (
                <Tab
                  key={t.id}
                  label={t.label}
                  isActive={activeView === t.id}
                  onClick={() => setActiveView(t.id)}
                />
              ))
            : PATIENT_TABS.map((t) => (
                <Tab
                  key={t.id}
                  label={t.label}
                  isActive={activePatientView === t.id}
                  onClick={() => setActivePatientView(t.id)}
                />
              ))}
        </nav>

        {/* right cluster */}
        <div className="flex shrink-0 items-center gap-3">
          <button
            className="hidden items-center gap-2 rounded-full border border-hairline px-3 py-1.5 text-[12px] text-text-tertiary transition hover:border-hairline-strong hover:text-text-secondary lg:flex"
            aria-label="Search"
          >
            <Search size={13} />
            Search
            <kbd className="rounded-md border border-hairline px-1.5 font-mono text-[10px]">⌘K</kbd>
          </button>

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
            <span className="text-text-tertiary">Viewing chart</span>
            <span className="font-medium text-text-primary">{patient.name}</span>
            <span className="tabular-nums text-text-tertiary">{patient.patientId}</span>
            <span className="ml-auto hidden items-center gap-1.5 text-text-tertiary sm:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald" />
              Consent active · expires in 24h
            </span>
          </div>
        </div>
      )}
    </header>
  );
}
