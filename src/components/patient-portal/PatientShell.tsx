"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LogOut, Home, CalendarDays, FileText, Pill, Receipt,
  ShieldCheck, Users, User as UserIcon, ClipboardList, ListChecks, KeyRound,
} from "lucide-react";
import { Sparkles } from "lucide-react";
import { ToastViewport } from "@/components/shared/ToastViewport";
import { ThemeToggle } from "@/components/navigation/ThemeToggle";
import { AiAssistantProvider, AiCommandBar } from "@/components/ai/PortalAssistant";

/**
 * Phase D11 — the patient experience shell. A simple, single navigation model
 * (brief §32) — no internal hospital jargon, no dead-end links. Same tokens as
 * the rest of Aarogya so the portal reads as one product.
 */
const NAV = [
  { href: "/patient", label: "Home", icon: Home },
  { href: "/patient/appointments", label: "Appointments", icon: CalendarDays },
  { href: "/patient/queue", label: "Queue", icon: ListChecks },
  { href: "/patient/share", label: "Share access", icon: KeyRound },
  { href: "/patient/records", label: "Records", icon: ClipboardList },
  { href: "/patient/reports", label: "Reports", icon: FileText },
  { href: "/patient/medications", label: "Medicines", icon: Pill },
  { href: "/patient/billing", label: "Bills", icon: Receipt },
  { href: "/patient/insurance", label: "Insurance", icon: ShieldCheck },
  { href: "/patient/consent", label: "Consent", icon: ShieldCheck },
  { href: "/patient/family", label: "Family", icon: Users },
  { href: "/patient/profile", label: "Profile", icon: UserIcon },
];

export function PatientShell({ children, displayName }: { children: React.ReactNode; displayName: string }) {
  const router = useRouter();
  const pathname = usePathname();

  async function handleLogout() {
    await fetch("/api/scholar-auth/logout", { method: "POST" });
    router.push("/patient/login");
    router.refresh();
  }

  const isActive = (href: string) => (href === "/patient" ? pathname === "/patient" : pathname.startsWith(href));

  return (
    <AiAssistantProvider role="PATIENT" displayName={displayName}>
    <div className="min-h-screen bg-surface text-text-primary">
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
            <ThemeToggle />
            <button onClick={handleLogout} className="flex items-center gap-1.5 rounded-md border border-hairline px-3 py-1.5 text-[12px] text-text-secondary hover:border-red/30 hover:text-red">
              <LogOut size={13} /> Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-5xl gap-6 px-4 py-6">
        <nav className="hidden w-44 shrink-0 flex-col gap-0.5 sm:flex">
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
                <Icon size={15} /> {item.label}
              </Link>
            );
          })}
        </nav>
        <main className="min-w-0 flex-1">{children}</main>
      </div>

      {/* Mobile: horizontal scrollable nav at the bottom. */}
      <nav className="sticky bottom-0 z-40 flex gap-1 overflow-x-auto border-t border-hairline bg-card px-2 py-1.5 sm:hidden">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link key={item.href} href={item.href} className={`flex shrink-0 flex-col items-center gap-0.5 rounded-md px-3 py-1 text-[10px] ${active ? "text-cyan" : "text-text-secondary"}`}>
              <Icon size={16} /> {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
    </AiAssistantProvider>
  );
}
