"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutGrid, BedDouble, ClipboardList, LogOut, Building2, Stethoscope,
  ClipboardCheck, FlaskConical, ScanLine, Receipt, DoorOpen,
  UserPlus, Siren, ArrowRightLeft, Pill, Microscope,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusPill } from "@/components/ui/StatusPill";
import { ToastViewport } from "@/components/shared/ToastViewport";

// Phase 4 Milestone D (brief §19) — `children` is additive/optional so
// every existing flat nav entry keeps working unchanged; only the new
// "Diagnostics" group uses it.
type NavItem = { href: string; label: string; icon: typeof LayoutGrid; children?: NavItem[] };

const DIAGNOSTICS_GROUP: NavItem = {
  href: "/hospital-os/diagnostics",
  label: "Diagnostics",
  icon: Microscope,
  children: [
    { href: "/hospital-os/diagnostics", label: "Overview", icon: Microscope },
    { href: "/hospital-os/lab", label: "Laboratory", icon: FlaskConical },
    { href: "/hospital-os/radiology", label: "Radiology", icon: ScanLine },
  ],
};

const NAV_BY_ROLE: Record<string, NavItem[]> = {
  HOSPITAL_ADMIN: [
    { href: "/hospital-os", label: "Command Center", icon: LayoutGrid },
    { href: "/hospital-os/front-desk", label: "Front Desk", icon: UserPlus },
    { href: "/hospital-os/ed", label: "ED Board", icon: Siren },
    { href: "/hospital-os/beds", label: "Beds", icon: BedDouble },
    { href: "/hospital-os/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/hospital-os/transfers", label: "Transfers", icon: ArrowRightLeft },
    { href: "/hospital-os/discharge", label: "Discharge", icon: DoorOpen },
    DIAGNOSTICS_GROUP,
    { href: "/hospital-os/pharmacy", label: "Pharmacy", icon: Pill },
    { href: "/hospital-os/billing", label: "Billing", icon: Receipt },
  ],
  AAROGYA_ADMIN: [
    { href: "/hospital-os", label: "Command Center", icon: LayoutGrid },
    { href: "/hospital-os/beds", label: "Beds", icon: BedDouble },
    { href: "/hospital-os/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/hospital-os/transfers", label: "Transfers", icon: ArrowRightLeft },
    { href: "/hospital-os/discharge", label: "Discharge", icon: DoorOpen },
    { href: "/hospital-os/billing", label: "Billing", icon: Receipt },
  ],
  DOCTOR: [
    { href: "/hospital-os/doctor", label: "My Patients", icon: Stethoscope },
    { href: "/hospital-os/ed", label: "ED Board", icon: Siren },
    { href: "/hospital-os", label: "Command Center", icon: LayoutGrid },
    { href: "/hospital-os/beds", label: "Beds", icon: BedDouble },
    { href: "/hospital-os/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/hospital-os/transfers", label: "Transfers", icon: ArrowRightLeft },
    { href: "/hospital-os/discharge", label: "Discharge", icon: DoorOpen },
    DIAGNOSTICS_GROUP,
  ],
  NURSE: [
    { href: "/hospital-os/nurse", label: "My Shift", icon: ClipboardCheck },
    { href: "/hospital-os/ed", label: "ED Board", icon: Siren },
    { href: "/hospital-os/beds", label: "Beds", icon: BedDouble },
    { href: "/hospital-os/transfers", label: "Transfers", icon: ArrowRightLeft },
    DIAGNOSTICS_GROUP,
  ],
  // Single-purpose operational roles keep their direct one-click link to
  // their own worklist (unchanged) and additionally get the cross-domain
  // Diagnostics overview as a second flat item — nesting their one
  // existing link inside a group they'd have to expand would be a step
  // backward for a role whose entire job is that one page.
  LAB_TECHNICIAN: [
    { href: "/hospital-os/lab", label: "Lab Queue", icon: FlaskConical },
    { href: "/hospital-os/diagnostics", label: "Diagnostics", icon: Microscope },
  ],
  RADIOLOGY_TECH: [
    { href: "/hospital-os/radiology", label: "Imaging Queue", icon: ScanLine },
    { href: "/hospital-os/diagnostics", label: "Diagnostics", icon: Microscope },
  ],
  PHARMACIST: [{ href: "/hospital-os/pharmacy", label: "Pharmacy", icon: Pill }],
  BILLING_STAFF: [{ href: "/hospital-os/billing", label: "Billing", icon: Receipt }],
  FRONT_DESK: [{ href: "/hospital-os/front-desk", label: "Front Desk", icon: UserPlus }],
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
            // Nested group (Diagnostics — brief §19): the parent is a
            // section label, not a link, since its own href would
            // otherwise duplicate the first child's destination.
            if (item.children) {
              return (
                <div key={item.href}>
                  <div className="flex items-center gap-2.5 px-3 pt-2 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
                    <item.icon size={13} /> {item.label}
                  </div>
                  {item.children.map((child) => {
                    const active = pathname === child.href;
                    return (
                      <Link key={child.href} href={child.href} className={cn("ml-3 flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[12.5px] transition", active ? "bg-cyan/10 text-cyan" : "text-text-secondary hover:bg-black/[0.03] hover:text-text-primary")}>
                        <child.icon size={13} /> {child.label}
                      </Link>
                    );
                  })}
                </div>
              );
            }
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
