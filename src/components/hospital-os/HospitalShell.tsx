"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutGrid, BedDouble, ClipboardList, LogOut, Building2, Stethoscope,
  ClipboardCheck, FlaskConical, ScanLine, Receipt, DoorOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/ui/StatusPill";
import { ToastViewport } from "@/components/shared/ToastViewport";

type NavItem = { href: string; label: string; icon: typeof LayoutGrid };

const NAV_BY_ROLE: Record<string, NavItem[]> = {
  HOSPITAL_ADMIN: [
    { href: "/hospital-os", label: "Command Center", icon: LayoutGrid },
    { href: "/hospital-os/beds", label: "Beds", icon: BedDouble },
    { href: "/hospital-os/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/hospital-os/discharge", label: "Discharge", icon: DoorOpen },
    { href: "/hospital-os/billing", label: "Billing", icon: Receipt },
  ],
  AAROGYA_ADMIN: [
    { href: "/hospital-os", label: "Command Center", icon: LayoutGrid },
    { href: "/hospital-os/beds", label: "Beds", icon: BedDouble },
    { href: "/hospital-os/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/hospital-os/discharge", label: "Discharge", icon: DoorOpen },
    { href: "/hospital-os/billing", label: "Billing", icon: Receipt },
  ],
  DOCTOR: [
    { href: "/hospital-os/doctor", label: "My Patients", icon: Stethoscope },
    { href: "/hospital-os", label: "Command Center", icon: LayoutGrid },
    { href: "/hospital-os/beds", label: "Beds", icon: BedDouble },
    { href: "/hospital-os/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/hospital-os/discharge", label: "Discharge", icon: DoorOpen },
  ],
  NURSE: [
    { href: "/hospital-os/nurse", label: "My Shift", icon: ClipboardCheck },
    { href: "/hospital-os/beds", label: "Beds", icon: BedDouble },
  ],
  LAB_TECHNICIAN: [{ href: "/hospital-os/lab", label: "Lab Queue", icon: FlaskConical }],
  RADIOLOGY_TECH: [{ href: "/hospital-os/radiology", label: "Imaging Queue", icon: ScanLine }],
  PHARMACIST: [{ href: "/hospital-os", label: "Command Center", icon: LayoutGrid }],
  BILLING_STAFF: [{ href: "/hospital-os/billing", label: "Billing", icon: Receipt }],
};

export function HospitalShell({
  children, displayName, displayRole, facilityName, role,
}: {
  children: React.ReactNode;
  displayName: string;
  displayRole: string;
  facilityName: string;
  role: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const nav = NAV_BY_ROLE[role] ?? [{ href: "/hospital-os", label: "Command Center", icon: LayoutGrid }];

  async function handleLogout() {
    await fetch("/api/scholar-auth/logout", { method: "POST" });
    router.push("/hospital-os/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen bg-surface text-text-primary">
      <ToastViewport />
      <aside className="sticky top-0 hidden h-screen w-[232px] shrink-0 flex-col border-r border-hairline bg-card px-4 py-5 lg:flex">
        <Link href="/hospital-os" className="flex items-center gap-2 px-2 text-[14px] font-semibold tracking-tight">
          <Building2 size={18} className="text-cyan" /> Hospital OS
        </Link>
        <div className="mt-5 rounded-lg border border-hairline bg-black/[0.02] px-3 py-3">
          <p className="truncate text-[13px] font-medium">{displayName}</p>
          <p className="mt-0.5 truncate text-[11px] text-text-tertiary">{facilityName}</p>
          <div className="mt-2"><StatusPill label={displayRole} tone="cyan" className="rounded-md" /></div>
        </div>
        <nav className="mt-5 flex-1 space-y-0.5">
          {nav.map((item) => {
            const active = pathname === item.href;
            return (
              <Link key={item.href} href={item.href} className={cn("flex items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition", active ? "bg-cyan/10 text-cyan" : "text-text-secondary hover:bg-black/[0.03] hover:text-text-primary")}>
                <item.icon size={15} /> {item.label}
              </Link>
            );
          })}
        </nav>
        <button onClick={handleLogout} className="flex items-center gap-2.5 rounded-md border-t border-hairline px-3 py-2.5 pt-3 text-left text-[12.5px] text-text-tertiary transition hover:text-red">
          <LogOut size={14} /> Sign out
        </button>
      </aside>
      <main className="min-w-0 flex-1 px-4 pb-16 pt-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
