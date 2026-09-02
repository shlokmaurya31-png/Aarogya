"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import {
  LayoutGrid, Stethoscope, Siren, Pill, MessageSquareText, NotebookPen, TrendingUp, IdCard,
  Menu, X, LogOut, GraduationCap, Flame,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/ui/StatusPill";
import { ToastViewport } from "@/components/shared/ToastViewport";

const NAV = [
  { href: "/student/dashboard", label: "Overview", icon: LayoutGrid },
  { href: "/student/cases", label: "Clinical Feed", icon: Stethoscope },
  { href: "/student/emergency", label: "Emergency Arena", icon: Siren },
  { href: "/student/rxlab", label: "RxLab", icon: Pill },
  { href: "/student/viva", label: "Viva AI", icon: MessageSquareText },
  { href: "/student/notebook", label: "Notebook", icon: NotebookPen },
  { href: "/student/progress", label: "Progress", icon: TrendingUp },
  { href: "/student/passport", label: "Clinical Passport", icon: IdCard },
];

export function ScholarShell({
  children, displayName, institution, course, academicYear, currentRotation, streakDays,
}: {
  children: React.ReactNode;
  displayName: string;
  institution: string;
  course: string;
  academicYear: number;
  currentRotation: string;
  streakDays: number;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  async function handleLogout() {
    await fetch("/api/scholar-auth/logout", { method: "POST" });
    router.push("/student");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen bg-surface text-text-primary">
      <ToastViewport />

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-hairline bg-card px-4 py-5 lg:flex">
        <Link href="/student/dashboard" className="flex items-center gap-2 px-2 text-[14px] font-semibold tracking-tight">
          <GraduationCap size={18} className="text-cyan" /> Aarogya Scholar
        </Link>

        <div className="mt-5 rounded-lg border border-hairline bg-black/[0.02] px-3 py-3">
          <p className="truncate text-[13px] font-medium">{displayName}</p>
          <p className="mt-0.5 truncate text-[11px] text-text-tertiary">{institution}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusPill label={course.replaceAll("_", " ")} tone="cyan" className="rounded-md" />
            <StatusPill label={`Year ${academicYear}`} tone="neutral" className="rounded-md" />
          </div>
          <p className="mt-2 text-[11px] text-text-tertiary">Rotation: {currentRotation}</p>
          {streakDays > 0 && (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-amber">
              <Flame size={11} /> {streakDays}-day streak
            </p>
          )}
        </div>

        <nav className="mt-5 flex-1 space-y-0.5">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname?.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition",
                  active ? "bg-cyan/10 text-cyan" : "text-text-secondary hover:bg-black/[0.03] hover:text-text-primary"
                )}
              >
                <item.icon size={15} /> {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="space-y-0.5 border-t border-hairline pt-3">
          <Link href="/student/profile" className="block rounded-md px-3 py-2 text-[12.5px] text-text-secondary transition hover:bg-black/[0.03] hover:text-text-primary">
            Profile & settings
          </Link>
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[12.5px] text-text-tertiary transition hover:bg-red/5 hover:text-red"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-40 flex items-center justify-between border-b border-hairline bg-card px-4 py-3 lg:hidden">
        <Link href="/student/dashboard" className="flex items-center gap-2 text-[13.5px] font-semibold">
          <GraduationCap size={16} className="text-cyan" /> Aarogya Scholar
        </Link>
        <button onClick={() => setMobileOpen((v) => !v)} aria-label="Menu">
          {mobileOpen ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 top-[49px] z-30 overflow-y-auto bg-card px-4 py-4 lg:hidden">
          <nav className="space-y-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-3 py-2.5 text-[13.5px]",
                  pathname === item.href ? "bg-cyan/10 text-cyan" : "text-text-secondary"
                )}
              >
                <item.icon size={16} /> {item.label}
              </Link>
            ))}
            <button onClick={handleLogout} className="flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-[13.5px] text-red">
              <LogOut size={16} /> Sign out
            </button>
          </nav>
        </div>
      )}

      <main className="min-w-0 flex-1 px-4 pb-16 pt-[64px] sm:px-6 lg:px-8 lg:pt-8">{children}</main>
    </div>
  );
}
