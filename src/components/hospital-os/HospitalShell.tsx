"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutGrid, BedDouble, ClipboardList, LogOut, Building2, CreditCard, Stethoscope,
  ClipboardCheck, FlaskConical, ScanLine, Receipt, DoorOpen,
  UserPlus, Siren, ArrowRightLeft, Pill, Microscope,
  ShieldCheck, BarChart3, Settings2, Boxes, Truck, HeartPulse, Scissors, Droplet, Wrench, Network, ShieldAlert, Plug,
  Menu, X, Search, Bell} from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/navigation/ThemeToggle";
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

// Phase 5 — Billing + Insurance + Revenue Cycle. Settings (tariffs/payers)
// is admin-only by convention here (a UX courtesy, not the auth boundary —
// see the comment on NavItem above); staff get Billing/Claims/Reconciliation.
const BILLING_GROUP_ADMIN: NavItem = {
  href: "/hospital-os/billing",
  label: "Billing",
  icon: Receipt,
  children: [
    { href: "/hospital-os/billing", label: "Encounters", icon: Receipt },
    { href: "/hospital-os/claims", label: "Claims", icon: ShieldCheck },
    // Phase C5 — the NHCX protocol boundary, deliberately a separate entry from
    // Claims so "not sent" never looks like "not answered".
    { href: "/hospital-os/claims/exchange", label: "Claims Exchange", icon: Network },
    { href: "/hospital-os/billing/reconciliation", label: "Reconciliation", icon: BarChart3 },
    { href: "/hospital-os/billing/settings", label: "Settings", icon: Settings2 },
  ],
};
const BILLING_GROUP_STAFF: NavItem = {
  href: "/hospital-os/billing",
  label: "Billing",
  icon: Receipt,
  children: [
    { href: "/hospital-os/billing", label: "Encounters", icon: Receipt },
    { href: "/hospital-os/claims", label: "Claims", icon: ShieldCheck },
  ],
};

// Phase 6A — Inventory + Procurement Foundation. Settings-level
// item/location/supplier/adjustment management is admin-only by
// convention here (a UX courtesy, not the auth boundary — see the
// comment on NavItem above); Pharmacy gets the stock overview + goods
// receiving worklists it's actually wired up to use.
const INVENTORY_GROUP: NavItem = {
  href: "/hospital-os/inventory",
  label: "Inventory",
  icon: Boxes,
  children: [
    { href: "/hospital-os/inventory", label: "Stock", icon: Boxes },
    { href: "/hospital-os/inventory/procurement", label: "Procurement", icon: Truck },
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
    { href: "/hospital-os/icu", label: "ICU", icon: HeartPulse },
    { href: "/hospital-os/ot", label: "Operating Theatre", icon: Scissors },
    { href: "/hospital-os/blood", label: "Blood Bank", icon: Droplet },
    DIAGNOSTICS_GROUP,
    { href: "/hospital-os/pharmacy", label: "Pharmacy", icon: Pill },
    INVENTORY_GROUP,
    { href: "/hospital-os/operations", label: "Operations", icon: Wrench },
    { href: "/hospital-os/interoperability", label: "Interoperability", icon: Network },
    // Phase C6 — the operational control plane over ABDM/FHIR/NHCX. Separate
    // from Interoperability, which is the day-to-day identity/consent/exchange
    // workspace; this one answers "is it on, is it healthy, what failed".
    { href: "/hospital-os/integrations", label: "Integrations", icon: Plug },
    { href: "/hospital-os/security", label: "Trust & Security", icon: ShieldAlert },
    // Phase D1 — the enterprise control plane (organizations, facilities,
    // memberships, hierarchical configuration).
    { href: "/hospital-os/enterprise", label: "Enterprise", icon: Building2 },
    // Phase D2 — the SaaS commercial control plane (plans/subscription/
    // entitlements/usage). Distinct from BILLING_GROUP_ADMIN, which is the
    // hospital patient revenue cycle.
    { href: "/hospital-os/enterprise/billing", label: "Commercial", icon: CreditCard },
    BILLING_GROUP_ADMIN,
  ],
  AAROGYA_ADMIN: [
    { href: "/hospital-os", label: "Command Center", icon: LayoutGrid },
    { href: "/hospital-os/beds", label: "Beds", icon: BedDouble },
    { href: "/hospital-os/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/hospital-os/transfers", label: "Transfers", icon: ArrowRightLeft },
    { href: "/hospital-os/discharge", label: "Discharge", icon: DoorOpen },
    { href: "/hospital-os/enterprise", label: "Enterprise", icon: Building2 },
    { href: "/hospital-os/enterprise/billing", label: "Commercial", icon: CreditCard },
    BILLING_GROUP_ADMIN,
  ],
  DOCTOR: [
    { href: "/hospital-os/doctor", label: "My Patients", icon: Stethoscope },
    { href: "/hospital-os/ed", label: "ED Board", icon: Siren },
    { href: "/hospital-os", label: "Command Center", icon: LayoutGrid },
    { href: "/hospital-os/beds", label: "Beds", icon: BedDouble },
    { href: "/hospital-os/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/hospital-os/transfers", label: "Transfers", icon: ArrowRightLeft },
    { href: "/hospital-os/discharge", label: "Discharge", icon: DoorOpen },
    { href: "/hospital-os/icu", label: "ICU", icon: HeartPulse },
    { href: "/hospital-os/ot", label: "Operating Theatre", icon: Scissors },
    { href: "/hospital-os/blood", label: "Blood Bank", icon: Droplet },
    DIAGNOSTICS_GROUP,
    { href: "/hospital-os/operations", label: "Operations", icon: Wrench },
  ],
  NURSE: [
    { href: "/hospital-os/nurse", label: "My Shift", icon: ClipboardCheck },
    { href: "/hospital-os/ed", label: "ED Board", icon: Siren },
    { href: "/hospital-os/beds", label: "Beds", icon: BedDouble },
    { href: "/hospital-os/transfers", label: "Transfers", icon: ArrowRightLeft },
    { href: "/hospital-os/icu", label: "ICU", icon: HeartPulse },
    { href: "/hospital-os/ot", label: "Operating Theatre", icon: Scissors },
    { href: "/hospital-os/blood", label: "Blood Bank", icon: Droplet },
    DIAGNOSTICS_GROUP,
    { href: "/hospital-os/operations", label: "Operations", icon: Wrench },
  ],
  // Single-purpose operational roles keep their direct one-click link to
  // their own worklist (unchanged) and additionally get the cross-domain
  // Diagnostics overview as a second flat item — nesting their one
  // existing link inside a group they'd have to expand would be a step
  // backward for a role whose entire job is that one page.
  LAB_TECHNICIAN: [
    { href: "/hospital-os/lab", label: "Lab Queue", icon: FlaskConical },
    { href: "/hospital-os/blood", label: "Blood Bank", icon: Droplet },
    { href: "/hospital-os/diagnostics", label: "Diagnostics", icon: Microscope },
  ],
  RADIOLOGY_TECH: [
    { href: "/hospital-os/radiology", label: "Imaging Queue", icon: ScanLine },
    { href: "/hospital-os/diagnostics", label: "Diagnostics", icon: Microscope },
  ],
  PHARMACIST: [{ href: "/hospital-os/pharmacy", label: "Pharmacy", icon: Pill }, INVENTORY_GROUP],
  // Phase B8 — the dedicated procurement role: inventory + procurement pipeline.
  PROCUREMENT_OFFICER: [{ href: "/hospital-os", label: "Command Center", icon: LayoutGrid }, INVENTORY_GROUP],
  BILLING_STAFF: [BILLING_GROUP_STAFF],
  FRONT_DESK: [
    { href: "/hospital-os/front-desk", label: "Front Desk", icon: UserPlus },
    { href: "/hospital-os/ed", label: "ED Board", icon: Siren },
    { href: "/hospital-os/operations", label: "Operations", icon: Wrench },
  ],
};

function NavList({ nav, pathname, onNavigate }: { nav: NavItem[]; pathname: string; onNavigate?: () => void }) {
  const itemClass = (active: boolean) =>
    cn(
      "focus-ring relative flex items-center gap-2.5 rounded-control px-3 py-2 text-[13px] font-medium transition-colors duration-[130ms]",
      active
        ? "bg-brand-subtle text-brand before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-brand"
        : "text-text-secondary hover:bg-fill-hover hover:text-text-primary"
    );
  return (
    <nav className="mt-4 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
      {nav.map((item) => {
        // Nested group (Diagnostics): the parent is a section label, not a link,
        // since its own href would duplicate the first child's destination.
        if (item.children) {
          return (
            <div key={item.href} className="pt-2">
              <div className="flex items-center gap-2 px-3 pb-1 type-label text-text-tertiary">
                <item.icon size={12} /> {item.label}
              </div>
              {item.children.map((child) => {
                const active = pathname === child.href;
                return (
                  <Link key={child.href} href={child.href} onClick={onNavigate} className={cn(itemClass(active), "ml-2.5 py-1.5 text-[12.5px]")}>
                    <child.icon size={14} /> {child.label}
                  </Link>
                );
              })}
            </div>
          );
        }
        const active = pathname === item.href;
        return (
          <Link key={item.href} href={item.href} onClick={onNavigate} className={itemClass(active)}>
            <item.icon size={15} /> {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

function SidebarContent({
  nav, pathname, displayName, displayRole, facilityName, onNavigate, onLogout,
}: {
  nav: NavItem[]; pathname: string; displayName: string; displayRole: string;
  facilityName: string; onNavigate?: () => void; onLogout: () => void;
}) {
  return (
    <div className="flex h-full flex-col px-3 py-4">
      <Link href="/hospital-os" onClick={onNavigate} className="focus-ring flex items-center gap-2 rounded-control px-2 py-1">
        <span className="flex size-7 items-center justify-center rounded-md bg-brand-strong text-on-brand">
          <Building2 size={16} />
        </span>
        <span className="type-heading text-text-primary">Hospital OS</span>
      </Link>
      <div className="mt-4 rounded-surface border border-hairline bg-fill-subtle px-3 py-2.5">
        <p className="truncate text-[13px] font-medium text-text-primary">{displayName}</p>
        <p className="mt-0.5 truncate text-[11px] text-text-tertiary">{facilityName}</p>
        <div className="mt-2"><StatusPill label={displayRole} tone="brand" /></div>
      </div>
      <NavList nav={nav} pathname={pathname} onNavigate={onNavigate} />
      <div className="mt-2 shrink-0 space-y-0.5 border-t border-hairline pt-2">
        <ThemeToggle variant="sidebar" />
        <button onClick={onLogout} className="focus-ring flex w-full items-center gap-2.5 rounded-control px-3 py-2 text-left text-[12.5px] font-medium text-text-tertiary transition-colors hover:bg-danger/10 hover:text-danger">
          <LogOut size={14} /> Sign out
        </button>
      </div>
    </div>
  );
}

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
  const [mobileOpen, setMobileOpen] = useState(false);
  const nav = NAV_BY_ROLE[role] ?? [{ href: "/hospital-os", label: "Command Center", icon: LayoutGrid }];

  async function handleLogout() {
    await fetch("/api/scholar-auth/logout", { method: "POST" });
    router.push("/hospital-os/login");
    router.refresh();
  }

  return (
    <div className="flex min-h-screen bg-surface text-text-primary">
      <ToastViewport />

      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-[240px] shrink-0 border-r border-hairline bg-card lg:block">
        <SidebarContent nav={nav} pathname={pathname} displayName={displayName} displayRole={displayRole} facilityName={facilityName} onLogout={handleLogout} />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm animate-[fadeIn_150ms_ease-out]" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[280px] max-w-[85vw] border-r border-hairline bg-card shadow-e3 animate-[slideInLeft_190ms_cubic-bezier(0.16,1,0.3,1)]">
            <button onClick={() => setMobileOpen(false)} className="focus-ring absolute right-2 top-2 flex size-8 items-center justify-center rounded-control text-text-tertiary hover:bg-fill-hover">
              <X size={16} />
            </button>
            <SidebarContent nav={nav} pathname={pathname} displayName={displayName} displayRole={displayRole} facilityName={facilityName} onNavigate={() => setMobileOpen(false)} onLogout={handleLogout} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-hairline bg-card/80 px-3 backdrop-blur-md sm:px-5">
          <button onClick={() => setMobileOpen(true)} className="focus-ring flex size-9 items-center justify-center rounded-control text-text-secondary hover:bg-fill-hover lg:hidden" aria-label="Open navigation">
            <Menu size={18} />
          </button>
          <div className="flex min-w-0 items-center gap-2">
            <Building2 size={15} className="hidden shrink-0 text-brand sm:block" />
            <span className="truncate text-[13px] font-medium text-text-primary">{facilityName}</span>
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <button className="focus-ring hidden h-9 items-center gap-2 rounded-control border border-hairline bg-fill-subtle px-3 text-[12.5px] text-text-tertiary transition-colors hover:bg-fill-hover md:flex" aria-label="Search">
              <Search size={14} /> <span>Search</span>
              <kbd className="ml-2 rounded border border-hairline px-1 text-[10px] text-text-tertiary">⌘K</kbd>
            </button>
            <button className="focus-ring flex size-9 items-center justify-center rounded-control text-text-secondary hover:bg-fill-hover md:hidden" aria-label="Search">
              <Search size={16} />
            </button>
            <button className="focus-ring relative flex size-9 items-center justify-center rounded-control text-text-secondary hover:bg-fill-hover" aria-label="Notifications">
              <Bell size={16} />
            </button>
            <div className="ml-1 flex size-8 items-center justify-center rounded-full bg-brand-subtle text-[12px] font-semibold text-brand" title={displayName}>
              {displayName.split(" ").map((w) => w[0]).slice(0, 2).join("")}
            </div>
          </div>
        </header>

        <main className="min-w-0 flex-1 px-4 pb-16 pt-5 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
